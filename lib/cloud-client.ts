/** Opt-in cloud transport. The current prototype continues to use its local adapter.
 * Never read or copy prototype localStorage into an authenticated account implicitly.
 */
import { ApiError } from "./api-error";

export type CloudSession = {
  subject: string;
  csrfToken: string;
  expiresAt: string;
};

type Fetcher = typeof fetch;

export class CloudClient {
  private session: CloudSession | null = null;
  private epoch = 0;
  private pending = new Set<AbortController>();
  private cache = new Map<string, unknown>();
  private channel: BroadcastChannel | null = null;

  private listeners = new Set<() => void>();
  private logoutCsrf: string | null = null;
  constructor(
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {}
  onInvalidated(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private invalidate() {
    this.clear();
    for (const listener of this.listeners) listener();
  }
  get subject() {
    return this.session?.subject ?? null;
  }

  /** Call from a browser effect; do not construct channels during SSR. */
  connectTabs() {
    if (typeof BroadcastChannel === "undefined" || this.channel) return;
    this.channel = new BroadcastChannel("form-cloud-session");
    this.channel.onmessage = (event) => {
      const subject = event.data?.subject;
      if (subject !== undefined && subject === this.session?.subject) return;
      if (this.session) this.invalidate();
    };
  }

  dispose() {
    this.clear();
    this.channel?.close();
    this.channel = null;
  }

  clear() {
    this.epoch++;
    this.session = null;
    this.cache.clear();
    for (const request of this.pending) request.abort();
    this.pending.clear();
  }

  private adopt(value: CloudSession | null) {
    if (this.session && this.session.subject !== value?.subject)
      this.invalidate();
    const first = !this.session && value;
    this.session = value;
    if (first) this.channel?.postMessage({ subject: value.subject });
  }

  async refreshSession(): Promise<CloudSession | null> {
    const epoch = this.epoch;
    const response = await this.fetcher("/auth/session", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (epoch !== this.epoch) throw new Error("ACCOUNT_CHANGED");
    if (response.status === 401) {
      this.invalidate();
      return null;
    }
    if (!response.ok)
      throw new ApiError(
        response.status,
        "SESSION_UNAVAILABLE",
        "GET",
        "/auth/session",
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        "GET",
        "/auth/session",
      );
    }
    if (epoch !== this.epoch) throw new Error("ACCOUNT_CHANGED");
    if (
      !value ||
      typeof value !== "object" ||
      !("subject" in value) ||
      typeof value.subject !== "string" ||
      !("csrfToken" in value) ||
      typeof value.csrfToken !== "string" ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "string"
    )
      throw new ApiError(
        response.status,
        "INVALID_SESSION",
        "GET",
        "/auth/session",
      );
    this.adopt(value as CloudSession);
    return this.session;
  }

  cached<T>(path: string): T | undefined {
    return this.cache.get(path) as T | undefined;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!/^\/v1\/[A-Za-z0-9_/?=&.%:-]+$/.test(path) || path.includes(".."))
      throw new Error("INVALID_API_PATH");
    if (!this.session) await this.refreshSession();
    if (!this.session) throw new Error("AUTHENTICATION_REQUIRED");
    const epoch = this.epoch;
    const subject = this.session.subject;
    const controller = new AbortController();
    this.pending.add(controller);
    const headers = new Headers(options.headers);
    headers.delete("authorization");
    headers.delete("x-owner-id");
    if ((options.method ?? "GET").toUpperCase() !== "GET")
      headers.set("X-CSRF-Token", this.session.csrfToken);
    try {
      const response = await this.fetcher("/api" + path, {
        ...options,
        headers,
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
      });
      if (epoch !== this.epoch) throw new Error("ACCOUNT_CHANGED");
      if (response.status === 401) {
        this.invalidate();
        this.channel?.postMessage({ subject: null });
        throw new Error("AUTHENTICATION_REQUIRED");
      }
      const responseSubject = response.headers.get("X-Form-Subject");
      // Gateway/BFF failures may precede authentication and have no subject header.
      // Never adopt a successful unbound response or any response bound to another account.
      if (
        (responseSubject !== null && responseSubject !== subject) ||
        (response.ok && responseSubject === null)
      ) {
        this.invalidate();
        this.channel?.postMessage({ subject: null });
        throw new Error("ACCOUNT_CHANGED");
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new ApiError(
          response.status,
          payload?.error?.code ?? "REQUEST_FAILED",
          (options.method ?? "GET").toUpperCase(),
          path.split("?", 1)[0],
        );
      }
      let data: unknown;
      try {
        data = response.status === 204 ? null : await response.json();
      } catch {
        throw new ApiError(
          response.status,
          "INVALID_RESPONSE",
          (options.method ?? "GET").toUpperCase(),
          path.split("?", 1)[0],
        );
      }
      if (epoch !== this.epoch) throw new Error("ACCOUNT_CHANGED");
      if ((options.method ?? "GET").toUpperCase() === "GET")
        this.cache.set(path, data);
      return data as T;
    } finally {
      this.pending.delete(controller);
    }
  }

  beginAccountSwitch() {
    this.invalidate();
    this.channel?.postMessage({ subject: null });
  }

  async logout() {
    const csrf = this.session?.csrfToken ?? this.logoutCsrf;
    if (!csrf) return;
    this.logoutCsrf = csrf;
    // Clear visible account state immediately. No browser storage is deleted.
    this.invalidate();
    this.channel?.postMessage({ subject: null });
    const result = await this.fetcher("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-CSRF-Token": csrf },
    });
    if (!result.ok && result.status !== 401)
      throw new Error("LOGOUT_RETRY_REQUIRED");
    this.logoutCsrf = null;
    return result.ok ? ((await result.json()) as { logoutUrl: string }) : null;
  }
}
