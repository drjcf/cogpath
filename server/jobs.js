/**
 * Launch a job for the worker. `cloudrun` runs a Cloud Run Job execution with COGPATH_JOB_ID set (the API's
 * service account needs run.jobs.run and run.jobs.runWithOverrides on the job); `local` spawns the worker as a
 * child process (development, tests).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateJob } from '../core/store.js';

export const runnerMode = () => process.env.COGPATH_JOB_RUNNER ?? (process.env.COGPATH_STORE === 'gcp' && process.env.COGPATH_WORKER_JOB ? 'cloudrun' : 'local');

export async function launchJob(job) {
  if (runnerMode() === 'cloudrun') {
    const { JobsClient } = await import('@google-cloud/run');
    const client = new JobsClient();
    const name = process.env.COGPATH_WORKER_JOB; // projects/<project>/locations/<region>/jobs/cogpath-worker
    if (!name) throw new Error('COGPATH_WORKER_JOB is not set');
    const [operation] = await client.runJob({ name, overrides: { containerOverrides: [{ env: [{ name: 'COGPATH_JOB_ID', value: job.id }] }] } });
    const execution = operation.name ?? null;
    await updateJob(job.id, { status: 'launched', launchedAt: new Date().toISOString(), execution, runner: 'cloudrun' });
    return { runner: 'cloudrun', execution };
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const worker = path.resolve(here, '../worker/index.js');
  const child = spawn(process.execPath, [worker], { env: { ...process.env, COGPATH_JOB_ID: job.id }, stdio: process.env.COGPATH_JOB_QUIET ? 'ignore' : 'inherit', detached: false });
  child.on('error', (e) => console.error(`[jobs] worker failed to start: ${e.message}`));
  await updateJob(job.id, { status: 'launched', launchedAt: new Date().toISOString(), execution: `pid:${child.pid}`, runner: 'local' });
  return { runner: 'local', pid: child.pid };
}
