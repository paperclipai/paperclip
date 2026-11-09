# Runner eval scoring slice

The package-local eval slice provides deterministic, credential-free scoring
for runner behavior. It complements the fail-fast conformance suite by keeping
each observation intact and reporting independent dimensions for safety,
semantic outcome, trajectory restraint, trace completeness, and efficiency.

`EvalBundle` records reproducibility inputs without storing credentials.
`assertBundleSecretFree` rejects credential-shaped keys and values before any
structural error can echo them. Persisted reports contain an explicit digested
bundle-evidence declaration rather than the free-form source bundle, while
`bundleId` still derives a stable content identifier from the full canonical
declaration. The exact final report serialization is scanned again before it is
returned to a persistence boundary.

`scoreEval` is pure: the same observation and bundle always produce the same
scorecard. Hard-invariant failures gate the overall score to zero. Other
dimensions remain separate so a report shows whether a regression came from
the semantic outcome, unnecessary calls, incomplete causal evidence, or an
exceeded declared budget.

`runEvalBehaviorFaultMatrix` exercises deterministic green and red behavior
against the package's mock authority. No provider process, network credential,
or paid model invocation is required.

Run the offline slice with:

```sh
pnpm --filter @paperclipai/paperclip-runner test:eval-slice
```

Provider-backed campaigns and recorded evidence are intentionally outside this
package boundary.
