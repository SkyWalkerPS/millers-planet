import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_REGISTRY_PREFIX = 'https://registry.npmjs.org/';
const FORBIDDEN_HOST_TEXT = 'reports.mn';
const JSDELIVR_BASE = 'https://cdn.jsdelivr.net/npm/';
const CONCURRENT_REQUESTS = 8;
const REQUEST_TIMEOUT_MS = 15000;

export function readLockedPackages(lockfileText) {
  const lockfile = JSON.parse(lockfileText);
  if (!lockfile.packages) throw new Error(`package-lock.json has no "packages" section (lockfileVersion ${lockfile.lockfileVersion}); only lockfile version 2 or 3 is supported`);
  return Object.entries(lockfile.packages)
    .filter(([key, entry]) => key !== '' && !entry.link)
    .map(([key, entry]) => ({
      key,
      name: entry.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version,
      resolved: entry.resolved,
    }));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

export async function confirmOnJsDelivr(name, version) {
  const url = `${JSDELIVR_BASE}${name}@${version}/package.json`;
  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchWithTimeout(url);
      if (response.status !== 200) {
        lastProblem = `HTTP ${response.status}`;
        if (response.status < 500) break;
        continue;
      }
      const manifest = await response.json();
      if (manifest.name !== name || manifest.version !== version) return { ok: false, problem: `jsDelivr returned ${manifest.name}@${manifest.version}` };
      return { ok: true };
    } catch (error) {
      lastProblem = error.name === 'AbortError' ? `no answer within ${REQUEST_TIMEOUT_MS / 1000} s` : error.message;
    }
  }
  return { ok: false, problem: `${lastProblem} from ${url}` };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lockfilePath = path.resolve(process.argv[2] || path.join(projectRoot, 'package-lock.json'));
  const lockfileText = readFileSync(lockfilePath, 'utf8');
  const problems = [];
  const forbiddenMentions = lockfileText.split(FORBIDDEN_HOST_TEXT).length - 1;
  if (forbiddenMentions) problems.push(`the lockfile mentions ${FORBIDDEN_HOST_TEXT} ${forbiddenMentions} time(s)`);
  const lockedPackages = readLockedPackages(lockfileText);
  for (const entry of lockedPackages) {
    if (!entry.version) problems.push(`${entry.key} has no version`);
    if (!entry.resolved) problems.push(`${entry.key} has no "resolved" URL`);
    else if (!entry.resolved.startsWith(REQUIRED_REGISTRY_PREFIX)) problems.push(`${entry.key} resolves to ${entry.resolved}, not ${REQUIRED_REGISTRY_PREFIX}`);
  }
  const uniquePairs = [...new Map(lockedPackages.filter((entry) => entry.version).map((entry) => [`${entry.name}@${entry.version}`, entry])).values()];
  console.log(`Checking ${lockfilePath}: ${lockedPackages.length} locked package(s), ${uniquePairs.length} distinct name@version pair(s)`);
  let confirmedCount = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < uniquePairs.length) {
      const entry = uniquePairs[nextIndex++];
      const result = await confirmOnJsDelivr(entry.name, entry.version);
      if (result.ok) confirmedCount++;
      else problems.push(`${entry.name}@${entry.version} could not be confirmed on jsDelivr: ${result.problem}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, worker));
  const resolvedOk = lockedPackages.filter((entry) => entry.resolved?.startsWith(REQUIRED_REGISTRY_PREFIX)).length;
  console.log(`  resolved URLs on ${REQUIRED_REGISTRY_PREFIX}: ${resolvedOk} of ${lockedPackages.length}`);
  console.log(`  mentions of ${FORBIDDEN_HOST_TEXT}: ${forbiddenMentions}`);
  console.log(`  confirmed on jsDelivr (HTTP 200 and matching name and version): ${confirmedCount} of ${uniquePairs.length}`);
  if (problems.length) {
    console.log(`\nlockfile check FAILED:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\nlockfile check passed');
}
