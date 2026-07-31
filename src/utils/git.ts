import { execa } from 'execa';
import { KnownError } from './error.js';

export const assertGitRepo = async () => {
	const { stdout, failed } = await execa(
		'git',
		['rev-parse', '--show-toplevel'],
		{ reject: false }
	);

	if (failed) {
		throw new KnownError('The current directory must be a Git repository!');
	}

	return stdout;
};

const excludeFromDiff = (path: string) => `:(exclude)${path}`;

const lockFilePatterns = [
	'package-lock.json',
	'pnpm-lock.yaml',
	// yarn.lock, Cargo.lock, Gemfile.lock, Pipfile.lock, etc.
	'*.lock',
];

const isLockFile = (file: string) => {
	return lockFilePatterns.some(pattern => {
		if (pattern.includes('*')) {
			// Simple glob match for *.lock
			return file.endsWith('.lock');
		}
		// Match lock files by basename to handle subdirectories
		return file.endsWith('/' + pattern) || file === pattern;
	});
};

const filesToExclude = lockFilePatterns.map(excludeFromDiff);

let rtkAvailable: boolean | undefined;

const isRtkAvailable = async () => {
	if (rtkAvailable !== undefined) {
		return rtkAvailable;
	}
	try {
		await execa('rtk', ['--version']);
		rtkAvailable = true;
	} catch {
		rtkAvailable = false;
	}
	return rtkAvailable;
};

/**
 * Get the diff for the given git diff args, condensed by rtk when it's installed.
 * Falls back to a plain `git diff` otherwise (e.g. on machines without rtk).
 *
 * rtk keeps the per-file stat line, a sample of the changed lines and a
 * truncation marker — a tiny fraction of the size of a raw diff on huge changes
 * (e.g. deleting a million-line file). Its `[full diff: ...]` hint line, which
 * appears at the end when the output was truncated, is stripped.
 */
const getDiff = async (diffArgs: string[]) => {
	const useRtk = await isRtkAvailable();
	const { stdout } = await execa(useRtk ? 'rtk' : 'git', [
		...(useRtk ? ['git'] : []),
		...diffArgs,
	]);
	return condenseDeletedFiles(stdout.replace(/\n\[full diff: [^\]]*\]\s*$/, ''));
};

const PREVIEW_PURE_LINES = 10;

/**
 * rtk shows up to 100 sample lines per hunk, even for a file that was wholly
 * deleted or added. For a commit message the model only needs to know the file
 * was deleted (or added) and a peek at its beginning, so shrink pure
 * add/delete hunks down to a few sample lines. Mixed hunks are left as-is.
 */
const condenseDeletedFiles = (diff: string) => {
	const lines = diff.split('\n');
	const out: string[] = [];
	let inPureHunk = false;
	let shownInHunk = 0;
	let skippedInHunk = 0;

	const flushMarker = () => {
		if (skippedInHunk > 0) {
			out.push(`  ... (${skippedInHunk} more lines)`);
			skippedInHunk = 0;
		}
	};

	for (const line of lines) {
		const hunkMatch = /^\s*@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunkMatch) {
			const removed = Number(hunkMatch[2] ?? 1);
			const added = Number(hunkMatch[4] ?? 1);
			// Pure deletion (removes lines, adds none) or pure addition.
			inPureHunk = (removed > 0 && added === 0) || (added > 0 && removed === 0);
			shownInHunk = 0;
			skippedInHunk = 0;
			out.push(line);
			continue;
		}

		if (inPureHunk) {
			// rtk's per-file tally line looks like `  +0 -200000` — not a change line.
			const isChangeLine = /^\s*[-+]/.test(line) && !/^\s*\+\d+ -\d+$/.test(line);
			if (isChangeLine) {
				if (shownInHunk < PREVIEW_PURE_LINES) {
					out.push(line);
					shownInHunk++;
				} else {
					skippedInHunk++;
				}
				continue;
			}
			if (/^\s*\.\.\./.test(line)) {
				// Absorb rtk's generic `... (N lines truncated)` marker into our own,
				// so the final count reflects every skipped line.
				const skipped = /\((\d+) lines truncated\)/.exec(line);
				if (skipped) {
					skippedInHunk += Number(skipped[1]);
				}
				continue;
			}
			// Hunk ended (stat/tally/next file) — flush our marker and leave.
			flushMarker();
			inPureHunk = false;
		}

		out.push(line);
	}

	flushMarker();
	return out.join('\n');
};

export const getStagedDiff = async (excludeFiles?: string[]) => {
	const diffCached = ['diff', '--cached', '--diff-algorithm=minimal'];
	const customExcludes = excludeFiles ? excludeFiles.map(excludeFromDiff) : [];

	// First, get all staged files without any excludes
	const { stdout: allFilesOutput } = await execa('git', [
		...diffCached,
		'--name-only',
		...customExcludes,
	]);

	if (!allFilesOutput) {
		return;
	}

	const allFiles = allFilesOutput.split('\n').filter(Boolean);

	// Check if all staged files are lock files
	const hasNonLockFiles = allFiles.some(file => !isLockFile(file));

	let excludes: string[] = [];
	if (hasNonLockFiles) {
		// If there are non-lock files, exclude lock files
		excludes = [...filesToExclude];
	}
	// If only lock files are staged, don't exclude them

	excludes = [...excludes, ...customExcludes];

	const files = hasNonLockFiles
		? allFiles.filter((file) => !isLockFile(file))
		: allFiles;

	if (files.length === 0) {
		return;
	}

	// Condense the diff via rtk when available (see getDiff).
	const diff = await getDiff([...diffCached, ...excludes]);

	return {
		files,
		diff,
	};
};

export const getStagedDiffForFiles = async (files: string[], excludeFiles?: string[]) => {
	const diffCached = ['diff', '--cached', '--diff-algorithm=minimal'];
	const excludes = [
		...filesToExclude,
		...(excludeFiles ? excludeFiles.map(excludeFromDiff) : []),
	];

	// Same rtk condensation as getStagedDiff (see getDiff).
	const diff = await getDiff([...diffCached, '--', ...files, ...excludes]);

	return {
		files,
		diff,
	};
};

export const getDetectedMessage = (files: string[]) =>
	`Detected ${files.length.toLocaleString()} staged file${
		files.length > 1 ? 's' : ''
	}`;
