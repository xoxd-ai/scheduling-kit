import { existsSync, readFileSync } from 'node:fs';

const repoRoot = new URL('../', import.meta.url);
const read = (relativePath) => readFileSync(new URL(relativePath, repoRoot), 'utf8');

const packageJson = JSON.parse(read('package.json'));
const moduleBazel = read('MODULE.bazel');
const buildBazel = read('BUILD.bazel');
const ciWorkflow = read('.github/workflows/ci.yml');

const extract = (source, pattern, label) => {
	const match = source.match(pattern);
	if (!match?.[1]) {
		throw new Error(`Unable to find ${label}`);
	}
	return match[1];
};

const expectedVersion = packageJson.version;
const expectedPackageName = packageJson.name;
const expectedPnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, '');
const expectedRepositoryUrl = 'git+https://github.com/tinyland-inc/scheduling-kit.git';

const includes = (source, needle) => source.includes(needle);
const scalar = (value) =>
	value
		.trim()
		.replace(/^(['"])(.*)\1\s*(?:#.*)?$/, '$2')
		.replace(/\s+#.*$/, '')
		.trim();
const usesPinnedPackageWorkflow = (workflow) =>
	/uses:\s*tinyland-inc\/ci-templates\/\.github\/workflows\/js-bazel-package\.yml@(?:[0-9a-fA-F]{40}|v[0-9]+\.[0-9]+\.[0-9]+)\b/.test(
		workflow,
	);
const hasWorkflowConcurrency = (workflow) => /\nconcurrency:\n/.test(workflow);
const doesNotInheritAllSecrets = (workflow) => !/secrets:\s*inherit/.test(workflow);
const hasNoWritePermission = (workflow) => !/^\s+[a-z-]+:\s*write\s*$/im.test(workflow);
const hasNoProviderPublicationSurface = (workflow) =>
	!/(github_package_name|github_package_registry|npm_access|npm_registry_url|npm_publish_provenance|NPM_TOKEN|TINYLAND_GITHUB_PACKAGES_TOKEN|npm\.pkg\.github\.com|registry\.npmjs\.org)/i.test(
		workflow,
	);

const checks = [
	{
		label: 'MODULE.bazel version',
		actual: extract(moduleBazel, /module\([\s\S]*?version = "([^"]+)"/m, 'module version'),
		expected: expectedVersion,
	},
	{
		label: 'BUILD.bazel npm_package version',
		actual: extract(buildBazel, /npm_package\([\s\S]*?version = "([^"]+)"/m, 'npm_package version'),
		expected: expectedVersion,
	},
	{
		label: 'BUILD.bazel npm_package name',
		actual: extract(buildBazel, /npm_package\([\s\S]*?package = "([^"]+)"/m, 'npm_package name'),
		expected: expectedPackageName,
	},
	{
		label: 'MODULE.bazel pnpm version',
		actual: extract(moduleBazel, /pnpm_version = "([^"]+)"/, 'pnpm_version'),
		expected: expectedPnpmVersion,
	},
	{
		label: 'package.json repository',
		actual: packageJson.repository?.url,
		expected: expectedRepositoryUrl,
	},
	{
		label: 'package.json omits publishConfig',
		actual: String(packageJson.publishConfig === undefined),
		expected: 'true',
	},
	{
		label: 'package.json omits publication lifecycle hook',
		actual: String(packageJson.scripts?.prepublishOnly === undefined),
		expected: 'true',
	},
	{
		label: 'CI reusable workflow pin',
		actual: String(usesPinnedPackageWorkflow(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'CI contents permission',
		actual: scalar(extract(ciWorkflow, /contents:\s*([^\n]+)/, 'CI contents permission')),
		expected: 'read',
	},
	{
		label: 'CI actions permission',
		actual: scalar(extract(ciWorkflow, /actions:\s*([^\n]+)/, 'CI actions permission')),
		expected: 'read',
	},
	{
		label: 'CI has no write permissions',
		actual: String(hasNoWritePermission(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'CI has no packages permission',
		actual: String(!/^\s+packages:/m.test(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'CI concurrency',
		actual: String(hasWorkflowConcurrency(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'CI least privilege secrets',
		actual: String(doesNotInheritAllSecrets(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'CI runner mode',
		actual: scalar(extract(ciWorkflow, /runner_mode:\s*([^\n]+)/, 'CI runner_mode')),
		expected: 'repo_owned',
	},
	{
		label: 'CI runner labels',
		actual: scalar(extract(ciWorkflow, /runner_labels_json:\s*([^\n]+)/, 'CI runner_labels_json')),
		expected: '${{ vars.PRIMARY_LINUX_RUNNER_LABELS_JSON }}',
	},
	{
		label: 'CI isolated workspace',
		actual: scalar(extract(ciWorkflow, /workspace_mode:\s*([^\n]+)/, 'CI workspace_mode')),
		expected: 'isolated',
	},
	{
		label: 'CI disables npm publication',
		actual: scalar(extract(ciWorkflow, /npm_publish_mode:\s*([^\n]+)/, 'CI npm_publish_mode')),
		expected: 'disabled',
	},
	{
		label: 'CI package artifact path',
		actual: scalar(extract(ciWorkflow, /package_dir:\s*([^\n]+)/, 'CI package_dir')),
		expected: './bazel-bin/pkg',
	},
	{
		label: 'CI Bazel package target',
		actual: String(
			includes(extract(ciWorkflow, /bazel_targets:\s*"([^"]+)"/, 'CI bazel_targets'), '//:pkg'),
		),
		expected: 'true',
	},
	{
		label: 'CI has no hosted exception',
		actual: String(!/(hosted_exception|ubuntu-latest)/.test(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'CI has no publication provider coordinates or secrets',
		actual: String(hasNoProviderPublicationSurface(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'GF PostgreSQL runner labels',
		actual: scalar(
			extract(
				ciWorkflow,
				/integration-postgres:[\s\S]*?runs-on:\s*([^\n]+)/,
				'GF PostgreSQL runs-on',
			),
		),
		expected: '${{ fromJSON(vars.PRIMARY_LINUX_RUNNER_LABELS_JSON) }}',
	},
	{
		label: 'GF PostgreSQL uses pinned nix setup',
		actual: String(
			/uses:\s*tinyland-inc\/ci-templates\/\.github\/actions\/nix-setup@(?:[0-9a-fA-F]{40}|v[0-9]+\.[0-9]+\.[0-9]+)\b/.test(
				ciWorkflow,
			),
		),
		expected: 'true',
	},
	{
		label: 'publication workflow removed',
		actual: String(!existsSync(new URL('.github/workflows/publish.yml', repoRoot))),
		expected: 'true',
	},
];

const failures = checks.filter((check) => check.actual !== check.expected);

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(
			`${failure.label} mismatch: expected "${failure.expected}", found "${failure.actual}"`,
		);
	}
	process.exit(1);
}

console.log(
	`release metadata aligned for ${expectedPackageName}@${expectedVersion}; GF validation only, BCR delivery`,
);
