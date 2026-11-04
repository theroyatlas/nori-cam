import { REPO, type WakeEnv } from '../wake.ts';

export class DispatchError extends Error {
  constructor(public definite: boolean, public status?: number) { super('dispatch_failed'); }
}
export function definiteDispatchFailure(error: unknown): boolean {
  if (error instanceof DispatchError) return error.definite;
  const e = error as { message?: string; cause?: { code?: string }; code?: string };
  return e?.message === 'dispatch_not_configured' || e?.message === 'invalid_workflow' ||
    ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e?.cause?.code || e?.code || '');
}
export async function dispatchWorkflow(
  env: Pick<WakeEnv, 'GH_DISPATCH_TOKEN'>,
  file: string,
  inputs: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!env.GH_DISPATCH_TOKEN) throw new Error('dispatch_not_configured');
  if (!/^[A-Za-z0-9_-]+\.ya?ml$/.test(file)) throw new Error('invalid_workflow');
  const response = await fetchFn(`https://api.github.com/repos/${REPO}/actions/workflows/${file}/dispatches`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nori-aipet-cam',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'master', inputs }),
  });
  if (response.status !== 204) throw new DispatchError(response.status >= 400 && response.status < 500, response.status);
}
