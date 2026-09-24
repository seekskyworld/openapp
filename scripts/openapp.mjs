import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, publicUrl } from './openapp-profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = resolve(root, '.openapp/processes.json');
const command = process.argv[2] || 'config';
const loaded = await loadProfile(root);

if (command === 'config') {
  console.log(JSON.stringify({ ...loaded.profile, publicUrl: publicUrl(loaded.profile) }, null, 2));
} else if (command === 'start') {
  await start(loaded.profile, loaded.env);
} else if (command === 'stop') {
  await stop(loaded.profile, loaded.env);
} else {
  throw new Error('usage: npm run openapp:{config|start|stop}');
}

async function start(profile, env) {
  if (profile.deployment.id === 'container') {
    if (profile.channel.buildContainerImage) {
      await run('docker', ['build', '-f', 'backend/deployment/portal/Dockerfile', '-t', profile.channel.containerImage, '.'], env);
    }
    await run('docker', composeArgs(profile, ['up', '-d']), env);
    console.log(`OpenApp started at ${publicUrl(profile)}`);
    return;
  }

  await ensureLocalPrerequisites(profile, env);
  if (profile.channel.buildBeforeStart) {
    await run('npm', ['--prefix', 'backend', 'run', profile.channel.id === 'stable' ? 'build:generic' : 'build'], env);
    await run('npm', ['--prefix', 'frontend', 'run', profile.channel.id === 'stable' ? 'build:generic' : 'build'], env);
  }

  const children = [];
  const backendArgs = profile.channel.id === 'dev'
    ? ['--prefix', 'backend', 'run', 'dev']
    : ['--prefix', 'backend', 'start'];
  children.push(spawnManaged('npm', backendArgs, env));
  if (profile.channel.frontend === 'vite') {
    children.push(spawnManaged('npm', [
      '--prefix', 'frontend', 'run', 'dev', '--',
      '--host', profile.deployment.frontendHost,
      '--port', String(profile.deployment.frontendPort),
    ], env));
  }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ pids: children.map((child) => child.pid) })}\n`, { mode: 0o600 });
  console.log(`OpenApp started at ${publicUrl(profile)}`);

  const shutdown = () => children.forEach((child) => child.kill('SIGTERM'));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const results = await Promise.all(children.map((child) => new Promise((resolveChild) => {
    child.once('exit', (code, signal) => resolveChild({ code, signal }));
  })));
  await rm(statePath, { force: true });
  if (results.some((result) => result.code && result.code !== 0)) process.exitCode = 1;
}

async function stop(profile, env) {
  if (profile.deployment.id === 'container') {
    await run('docker', composeArgs(profile, ['stop', 'portal']), env);
    console.log('OpenApp Portal container stopped; PostgreSQL remains running.');
    return;
  }
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') { console.log('No managed local OpenApp processes are recorded.'); return; }
    throw error;
  }
  for (const pid of Array.isArray(state.pids) ? state.pids : []) {
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
  }
  await rm(statePath, { force: true });
  console.log('Managed local OpenApp processes stopped.');
}

function composeArgs(profile, action) {
  return ['compose', '-f', profile.deployment.composeFile, ...action];
}

async function ensureLocalPrerequisites(profile, env) {
  if (!env.DATABASE_URL) throw new Error('local deployment requires DATABASE_URL in .env.local or the shell environment');
  await run('docker', ['version', '--format', '{{.Server.Version}}'], env, true);
  const composeFiles = profile.deployment.databaseComposeFiles ?? [];
  if (composeFiles.length) {
    const args = ['compose'];
    for (const file of composeFiles) args.push('-f', file);
    args.push('up', '-d', '--wait', profile.deployment.databaseService);
    await run('docker', args, env);
  }
}

function spawnManaged(binary, args, env) {
  const child = spawn(binary, args, { cwd: root, env, stdio: 'inherit' });
  child.on('error', (error) => console.error(`${binary} failed: ${error.message}`));
  return child;
}

function run(binary, args, env, quiet = false) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`${binary} exited with ${code ?? signal}`)));
  });
}
