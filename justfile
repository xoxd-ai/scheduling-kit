# scheduling-kit justfile
#
# Org house-style: invoke recipes through the repo flake devShell, e.g.
#   nix develop --command just info
#   nix develop --command just cache-contract-strict
#
# Cache-first only (TIN-1997 Option D / TIN-2110). There is intentionally NO
# executor recipe: REAPI / remote execution is out of scope. The shared Bazel
# cache endpoint is supplied at runtime via BAZEL_REMOTE_CACHE (injected in CI by
# the in-cluster nix-setup); it is never baked into .bazelrc.

# FLYWHEEL gates the cache-backed lane. When FLYWHEEL=1 the build/test recipes
# attach to the shared cache (--config=ci-cached --remote_cache=$BAZEL_REMOTE_CACHE,
# read-only). FLYWHEEL defaults to 1 when BAZEL_REMOTE_CACHE is set, so the
# enrolled lane is the default where it exists (TIN-5770, R471). Otherwise it
# defaults to 0 and the recipes run the plain local Bazel path, labelled
# "local, non-qualifying", so contributors without cluster cache reachability are
# never blocked. Set FLYWHEEL=0 to force the local path.
BAZEL_REMOTE_CACHE := env_var_or_default("BAZEL_REMOTE_CACHE", "")
FLYWHEEL := env_var_or_default("FLYWHEEL", if BAZEL_REMOTE_CACHE != "" { "1" } else { "0" })
BAZEL_TARGETS := "//:typecheck //:pkg //:test"

# List available recipes.
default:
	@just --list

# Print enrollment + cache posture for this checkout.
info:
	@echo "scheduling-kit — GloriousFlywheel cache enrollment (cache-first, TIN-2110)"
	@echo "FLYWHEEL:           {{FLYWHEEL}}"
	@echo "BAZEL_REMOTE_CACHE: {{ if BAZEL_REMOTE_CACHE == '' { 'unset (compatibility-local-only)' } else { BAZEL_REMOTE_CACHE } }}"
	@echo "bazel targets:      {{BAZEL_TARGETS}}"
	@echo "executor:           out of scope (cache-first only; no REAPI)"
	@echo "endpoint policy:    injected at runtime by nix-setup; never baked into .bazelrc"

# Fail-closed cache-attachment contract checker (the enrollment self-verify).
# Asserts a real shared-cache endpoint before any cache-backed Bazel work.
cache-contract-strict:
	GF_BAZEL_SUBSTRATE_MODE="${GF_BAZEL_SUBSTRATE_MODE:-shared-cache-backed}" \
		bash scripts/cache-attachment-contract.sh --strict

# Bazel build; FLYWHEEL=1 attaches to the shared cache (read-only), else local.
flywheel-build:
	#!/usr/bin/env bash
	set -euo pipefail
	if [ "{{FLYWHEEL}}" = "1" ]; then
		GF_BAZEL_SUBSTRATE_MODE="${GF_BAZEL_SUBSTRATE_MODE:-shared-cache-backed}" \
			bash scripts/cache-attachment-contract.sh --strict
		bazel build {{BAZEL_TARGETS}} \
			--config=ci-cached \
			--remote_cache="${BAZEL_REMOTE_CACHE}" \
			--remote_upload_local_results=false \
			--verbose_failures
	else
		echo "flywheel-build: local, non-qualifying (FLYWHEEL={{FLYWHEEL}})" >&2
		bazel build {{BAZEL_TARGETS}} --verbose_failures
	fi

# Bazel test; FLYWHEEL=1 attaches to the shared cache (read-only), else local.
flywheel-test:
	#!/usr/bin/env bash
	set -euo pipefail
	if [ "{{FLYWHEEL}}" = "1" ]; then
		GF_BAZEL_SUBSTRATE_MODE="${GF_BAZEL_SUBSTRATE_MODE:-shared-cache-backed}" \
			bash scripts/cache-attachment-contract.sh --strict
		bazel test //:test \
			--config=ci-cached \
			--remote_cache="${BAZEL_REMOTE_CACHE}" \
			--remote_upload_local_results=false \
			--verbose_failures
	else
		echo "flywheel-test: local, non-qualifying (FLYWHEEL={{FLYWHEEL}})" >&2
		bazel test //:test --verbose_failures
	fi
