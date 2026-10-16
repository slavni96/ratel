import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const publishRc = readFileSync(new URL("./publish-rc.sh", import.meta.url), "utf8");
const verifyInstallWorkflow = readFileSync(
  new URL("../.github/workflows/verify-install.yml", import.meta.url),
  "utf8",
);

test("main push path filtering checks out the repository first", () => {
  const changesJob = jobBody(ciWorkflow, "changes");
  const checkout = changesJob.indexOf("uses: actions/checkout@");
  const pathsFilter = changesJob.indexOf("uses: dorny/paths-filter@");

  assert.notEqual(checkout, -1, "changes job must check out the repository");
  assert.ok(checkout < pathsFilter, "checkout must run before paths-filter");
});

for (const job of ["verify-vercel-ai-sdk", "verify-mastra"]) {
  test(`${job} co-installs @ratel-ai/sdk@latest without interpolating a specific SDK version`, () => {
    const body = jobBody(verifyInstallWorkflow, job);

    assert.match(body, /"@ratel-ai\/sdk@latest"/);
    assert.doesNotMatch(body, /"@ratel-ai\/sdk@\$\{\{/);
  });
}

for (const job of ["publish-mastra", "publish-vercel-ai-sdk"]) {
  test(`${job} pins the SDK peer via pin-adapter-sdk-peer.mjs, not a caret of SDK_VER`, () => {
    const body = jobBody(releaseWorkflow, job);
    assert.match(body, /node scripts\/pin-adapter-sdk-peer\.mjs/);
    assert.doesNotMatch(body, /const v='\^'\+process\.env\.SDK_VER/);
    assert.doesNotMatch(body, /npm view "@ratel-ai\/sdk@\^\$\{sdk_ver\}"/);
  });
}

test("publish-vercel-ai-sdk pins telemetry with the release caret on runtime and dev", () => {
  const body = jobBody(releaseWorkflow, "publish-vercel-ai-sdk");
  assert.ok(
    body.includes(
      "const v='^'+process.env.TELE_VER; p.dependencies['@ratel-ai/telemetry']=v; p.devDependencies['@ratel-ai/telemetry']=v",
    ),
  );
  assert.ok(body.includes('npm view "@ratel-ai/telemetry@^${tele_ver}" version'));
});

// A tag pushed on a release PR's head before a squash or rebase merge lands on a commit main
// never contains (sdk-ts-v0.13.0-rc.11, core-v0.12.0-rc.6). Warn on it; blocking is a policy
// call for the maintainers, so the step must never fail the job.
test("tag-version-check warns, without failing, when the tagged commit is not on main", () => {
  const body = jobBody(releaseWorkflow, "tag-version-check");
  assert.match(body, /fetch-depth: 0/, "full history, so origin/main is there to compare against");

  const start = body.indexOf("- name: Warn when the tagged commit is not on main");
  assert.notEqual(start, -1, "missing the off-main warning step");
  const next = body.indexOf("\n      - ", start + 1);
  const step = next === -1 ? body.slice(start) : body.slice(start, next);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(step, /::warning/);
  assert.doesNotMatch(step, /exit 1/);
  // A dispatch checks out inputs.ref, not the tag's commit, so the message names the
  // built ref there instead of saying the tag points at it.
  assert.match(step, /EVENT: \$\{\{ github\.event_name \}\}/);
  assert.match(step, /REF: \$\{\{ inputs\.ref \}\}/);
  assert.match(step, /if \[ "\$EVENT" = "push" \]/);
  assert.match(step, /Built ref \$\{REF:-main\} \(\$sha\)/);
});

test("publish-rc.sh restores adapter manifests with a git checkout EXIT trap", () => {
  assert.match(publishRc, /trap .*git .*checkout/);
});

// Scoped to the `ts` filter on purpose: workflow-contracts and mastra's
// package-layout test run in the `ts` job, so a release.yml-only PR must trip it.
// A file-wide match would keep passing if the path moved to another filter.
test("ts path filter lists release.yml", () => {
  const ts = ciWorkflow.indexOf("\n            ts:");
  const next = ciWorkflow.indexOf("\n            python:", ts);
  assert.ok(ciWorkflow.slice(ts, next).includes("- '.github/workflows/release.yml'"));
});

test("ts path filter lists verify-install.yml", () => {
  const ts = ciWorkflow.indexOf("\n            ts:");
  const next = ciWorkflow.indexOf("\n            python:", ts);
  assert.ok(ciWorkflow.slice(ts, next).includes("- '.github/workflows/verify-install.yml'"));
});

// adr-index.test.mjs runs in the `ts` job, and the PR that adds a duplicate ADR number
// usually touches nothing but docs/adr/, so the filter has to see that path. It also reads
// the ADR index in docs/README.md, so a PR that edits only the index must re-run it too.
test("ts path filter lists docs/adr/** and docs/README.md", () => {
  const ts = ciWorkflow.indexOf("\n            ts:");
  const next = ciWorkflow.indexOf("\n            python:", ts);
  const filter = ciWorkflow.slice(ts, next);
  assert.ok(filter.includes("- 'docs/adr/**'"));
  assert.ok(filter.includes("- 'docs/README.md'"));
});

function jobBody(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:`);
  assert.notEqual(start, -1, `missing ${job} job`);

  const rest = workflow.slice(start + 1);
  const nextJob = rest.slice(1).search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}
