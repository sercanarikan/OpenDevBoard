// Where screenshots go. One central convention for all scripts:
//   <root>/<YYYY-MM-DD>/<version>/<topic>/[run]/
//
// Milestone version: 'v6' (Phase 6 / Final Validation baseline).
// Writing to v1, v2, v3, v4, or v5 is strictly forbidden to protect historical artifacts.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CURRENT_MILESTONE_VERSION = 'v6';

export function shotsRoot() {
  if (process.env.SHOTS_ROOT || process.env.SCREENSHOTS_ROOT) {
    return path.resolve(process.env.SHOTS_ROOT || process.env.SCREENSHOTS_ROOT);
  }
  return path.join(repo, 'screenshots');
}

export function resolveVersion(batch) {
  const wanted = batch || process.env.SHOT_BATCH || CURRENT_MILESTONE_VERSION;
  if (wanted === 'v1' || wanted === 'v2' || wanted === 'v3' || wanted === 'v4' || wanted === 'v5') {
    throw new Error(
      `[shot-dir] Attempted to use deprecated screenshot version '${wanted}'. ` +
      `Phase 6 milestone requires '${CURRENT_MILESTONE_VERSION}' or higher. Writing to v1-v5 is prohibited.`
    );
  }
  if (/^v\d+$/.test(wanted)) {
    const num = parseInt(wanted.slice(1), 10);
    if (num < 6) {
      throw new Error(`[shot-dir] Screenshot version '${wanted}' is below Phase 6 baseline ('${CURRENT_MILESTONE_VERSION}').`);
    }
    return wanted;
  }
  return CURRENT_MILESTONE_VERSION;
}

export function manifestPath(dayOverride, versionOverride) {
  const day = dayOverride || process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
  const version = resolveVersion(versionOverride);
  const dir = path.join(shotsRoot(), day, version);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'manifest.jsonl');
}

export function shotDir(explicit, runOrTopic, topicOverride) {
  if (explicit) {
    const resolvedExplicit = path.resolve(explicit);
    if (resolvedExplicit.includes('/v1/') || resolvedExplicit.includes('\\v1\\') ||
        resolvedExplicit.includes('/v2/') || resolvedExplicit.includes('\\v2\\') ||
        resolvedExplicit.includes('/v3/') || resolvedExplicit.includes('\\v3\\') ||
        resolvedExplicit.includes('/v4/') || resolvedExplicit.includes('\\v4\\') ||
        resolvedExplicit.includes('/v5/') || resolvedExplicit.includes('\\v5\\')) {
      throw new Error(`[shot-dir] Explicit path '${resolvedExplicit}' points to deprecated v1-v5.`);
    }
    fs.mkdirSync(resolvedExplicit, { recursive: true });
    return resolvedExplicit;
  }

  const day = (process.env.SHOT_DATE || new Date().toISOString().slice(0, 10));
  const version = resolveVersion();

  let topic = topicOverride || process.env.SHOT_TOPIC;
  let run = runOrTopic;

  if (!topic && runOrTopic) {
    if (runOrTopic.startsWith('e2e-')) {
      topic = 'e2e';
      run = runOrTopic.replace('e2e-', '');
    } else if (runOrTopic === 'matrix') {
      topic = 'responsive';
      run = '';
    } else {
      topic = runOrTopic;
      run = '';
    }
  }

  topic = topic || 'final-validation';

  // Standard target: <root>/<day>/<version>/<topic>/
  let target = path.join(shotsRoot(), day, version, topic);
  if (run && run !== 'matrix' && run !== topic && !run.startsWith('matrix-')) {
    target = path.join(target, run);
  }

  // Safety validation: verify resolved path is under v6+ and never v1-v5
  const normalized = path.normalize(target);
  if (normalized.includes(path.sep + 'v1' + path.sep) ||
      normalized.includes(path.sep + 'v2' + path.sep) ||
      normalized.includes(path.sep + 'v3' + path.sep) ||
      normalized.includes(path.sep + 'v4' + path.sep) ||
      normalized.includes(path.sep + 'v5' + path.sep)) {
    throw new Error(`[shot-dir] Output path validation failed: '${normalized}' targets deprecated version.`);
  }

  fs.mkdirSync(normalized, { recursive: true });
  return normalized;
}

/**
 * Manifest generator helper: guarantees unique manifest entries per file.
 * If an entry for the file already exists, it updates in-place.
 */
export function recordManifestEntry(manifestFilePath, entry) {
  const mPath = manifestFilePath || manifestPath();
  const normalizedTarget = path.normalize(entry.file);
  let lines = [];
  if (fs.existsSync(mPath)) {
    lines = fs.readFileSync(mPath, 'utf8').trim().split('\n').filter(Boolean);
  }

  const newEntry = {
    timestamp: new Date().toISOString(),
    version: CURRENT_MILESTONE_VERSION,
    ...entry,
    file: normalizedTarget
  };

  let replaced = false;
  const updatedLines = lines.map(line => {
    try {
      const parsed = JSON.parse(line);
      if (path.normalize(parsed.file) === normalizedTarget) {
        replaced = true;
        return JSON.stringify(newEntry);
      }
    } catch {}
    return line;
  });

  if (!replaced) {
    updatedLines.push(JSON.stringify(newEntry));
  }

  fs.writeFileSync(mPath, updatedLines.join('\n') + '\n', 'utf8');
}

/**
 * Ensures UI is genuinely in expected route and ready-state before capturing.
 * Fails immediately if current URL or expected page selector does not match.
 */
export async function captureVerifiedScreenshot(page, filePath, meta = {}) {
  // 1. Verify URL if expectedUrl is provided
  if (meta.expectedUrl) {
    const currentUrl = page.url();
    if (!currentUrl.includes(meta.expectedUrl)) {
      throw new Error(`[shot-dir] Screenshot aborted! Expected URL '${meta.expectedUrl}', but found '${currentUrl}'`);
    }
  }

  // 2. Verify page identity selector if expectedSelector is provided
  if (meta.expectedSelector) {
    const isVisible = await page.locator(meta.expectedSelector).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!isVisible) {
      throw new Error(`[shot-dir] Screenshot aborted! Expected page selector '${meta.expectedSelector}' not visible.`);
    }
  }

  // 3. Verify ready state: wait for active spinners to detach
  const state = meta.state || 'ready';
  if (state === 'ready') {
    try {
      const spinners = page.locator('.animate-spin, [data-testid*="-loading"]');
      const count = await spinners.count();
      for (let i = 0; i < count; i++) {
        await spinners.nth(i).waitFor({ state: 'hidden', timeout: 3000 }).catch(() => null);
      }
    } catch {}
  }

  await page.screenshot({ path: filePath });
  recordManifestEntry(undefined, {
    file: filePath,
    module: meta.module || 'general',
    viewport: meta.viewport || page.viewportSize() || { width: 1440, height: 900 },
    state,
    theme: meta.theme || 'light',
    locale: meta.locale || 'tr',
    route: meta.route || new URL(page.url()).pathname
  });
}

/**
 * Audits manifest against PNGs on disk. Fails if duplicate lines, missing files,
 * or unrecorded disk PNGs are found.
 */
export function verifyManifestIntegrity(dayOverride, versionOverride) {
  const day = dayOverride || process.env.SHOT_DATE || new Date().toISOString().slice(0, 10);
  const version = resolveVersion(versionOverride);
  const dir = path.join(shotsRoot(), day, version);
  const mPath = path.join(dir, 'manifest.jsonl');

  if (!fs.existsSync(mPath)) {
    return { success: false, error: `Manifest file missing at ${mPath}`, diskCount: 0, manifestCount: 0 };
  }

  const lines = fs.readFileSync(mPath, 'utf8').trim().split('\n').filter(Boolean);
  const duplicates = [];
  const manifestFiles = new Set();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const norm = path.normalize(entry.file);
      if (manifestFiles.has(norm)) {
        duplicates.push(norm);
      }
      manifestFiles.add(norm);
    } catch (e) {
      return { success: false, error: `Invalid JSON line in manifest: ${e.message}`, diskCount: 0, manifestCount: lines.length };
    }
  }

  if (duplicates.length > 0) {
    return {
      success: false,
      error: `Manifest contains ${duplicates.length} duplicate file entries`,
      duplicates,
      diskCount: 0,
      manifestCount: lines.length
    };
  }

  // Scan disk for all png files
  const diskFiles = [];
  function scan(current) {
    if (!fs.existsSync(current)) return;
    for (const item of fs.readdirSync(current)) {
      const fp = path.join(current, item);
      if (fs.statSync(fp).isDirectory()) {
        scan(fp);
      } else if (item.endsWith('.png')) {
        diskFiles.push(path.normalize(fp));
      }
    }
  }
  scan(dir);

  const missingOnDisk = [...manifestFiles].filter(f => !fs.existsSync(f));
  const unrecordedOnDisk = diskFiles.filter(f => !manifestFiles.has(f));

  if (missingOnDisk.length > 0) {
    return {
      success: false,
      error: `Manifest references ${missingOnDisk.length} files that do not exist on disk`,
      missingOnDisk,
      diskCount: diskFiles.length,
      manifestCount: manifestFiles.size
    };
  }

  if (unrecordedOnDisk.length > 0) {
    return {
      success: false,
      error: `${unrecordedOnDisk.length} disk PNG files are not recorded in manifest.jsonl`,
      unrecordedOnDisk,
      diskCount: diskFiles.length,
      manifestCount: manifestFiles.size
    };
  }

  return {
    success: true,
    diskCount: diskFiles.length,
    manifestCount: manifestFiles.size,
    unrecordedOnDisk: []
  };
}
