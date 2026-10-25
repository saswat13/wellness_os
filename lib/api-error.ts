export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public method?: string,
    public path?: string,
  ) {
    super(
      method && path
        ? `API_${status}: ${code} (${method} ${path})`
        : `API_${status}: ${code}`,
    );
  }
  get conflict() {
    return this.status === 409 || this.status === 412;
  }
}
