import { z } from "zod";
import { CloudClient } from "./cloud-client";
import { ApiError } from "./api-error";
import type { Operations } from "./api-v1.generated";

export { ApiError } from "./api-error";
type ListKey = {
  [K in keyof Operations]: Operations[K]["response"] extends {
    items: unknown[];
  }
    ? K
    : never;
}[keyof Operations];
type Item<K extends ListKey> = Operations[K]["response"] extends {
  items: Array<infer T>;
}
  ? T
  : never;
const envelope = z.object({ meta: z.object({ requestId: z.string() }) });
export class FormApi {
  constructor(public readonly transport = new CloudClient()) {}
  async call<K extends keyof Operations>(
    operation: K,
    options: {
      body?: Operations[K]["body"];
      params?: Record<string, string | number>;
      query?: Record<string, string>;
      revision?: number;
      key?: string;
    } = {},
  ): Promise<Operations[K]["response"]> {
    const [method, pattern] = operation.split(" ");
    const path =
      pattern.replace(/\{(\w+)\}/g, (_, k) => {
        const value = String(options.params?.[k] ?? "");
        if (!/^[A-Za-z0-9_-]+$/.test(value))
          throw new Error("INVALID_RESOURCE_ID");
        return value;
      }) +
      (options.query
        ? "?" + new URLSearchParams(options.query).toString()
        : "");
    const headers: Record<string, string> = {};
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = options.key ?? crypto.randomUUID();
      if (options.revision !== undefined)
        headers["If-Match"] = `"${options.revision}"`;
    }
    let result: Operations[K]["response"];
    try {
      result = await this.transport.request<Operations[K]["response"]>(path, {
        method,
        headers,
        ...(method === "GET"
          ? {}
          : { body: JSON.stringify(options.body ?? {}) }),
      });
    } catch (error) {
      if (error instanceof ApiError)
        throw new ApiError(error.status, error.code, method, pattern);
      throw error;
    }
    if (result !== null) {
      try {
        envelope.parse(result);
      } catch {
        throw new ApiError(200, "INVALID_RESPONSE", method, pattern);
      }
    }
    return result;
  }
  async all<K extends ListKey>(
    operation: K,
    params?: Record<string, string>,
    query: Record<string, string> = {},
  ): Promise<Array<Item<K>>> {
    const items: Array<Item<K>> = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const response = (await this.call(operation, {
        params,
        query: { ...query, limit: "100", ...(cursor ? { cursor } : {}) },
      })) as unknown as { items: Array<Item<K>>; nextCursor: string | null };
      if (
        !Array.isArray(response.items) ||
        (response.nextCursor !== null &&
          typeof response.nextCursor !== "string")
      )
        throw new Error("INVALID_PAGE");
      items.push(...response.items);
      cursor = response.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error("REPEATED_CURSOR");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
}
