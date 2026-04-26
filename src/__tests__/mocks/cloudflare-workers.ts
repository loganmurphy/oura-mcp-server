/**
 * Minimal stub for `cloudflare:workers` used during Vitest runs.
 * The real module is only available inside the Cloudflare Workers runtime.
 */

export class WorkerEntrypoint<Env = unknown> {
  protected readonly env: Env
  protected readonly ctx: ExecutionContext

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  // Optional lifecycle hooks (not used in this project)
  fetch?(_request: Request): Promise<Response> {
    return Promise.resolve(new Response("Not implemented", { status: 500 }))
  }
}

export class DurableObject<Env = unknown> {
  protected readonly env: Env
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly ctx: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(ctx: any, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class RpcTarget {}
