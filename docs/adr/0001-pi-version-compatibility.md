# Support Pi 1.1.0 and newer

An exact Pi 1.0.2 check in the former comparison script made optional rehearsals fail after a global Pi upgrade, even though the repository's development dependencies remain pinned. Support Pi >=1.1.0. The baseline was raised from 1.0.2 to 1.1.0 on 2026-10-22 as the new development and support target. No runtime changes were required. This lets users upgrade Pi while keeping a reproducible baseline for development.

Development dependencies are pinned to 1.1.0. The development install also pins Pi’s `pi-codemode` dependency to 1.1.0: 1.4.0 removes an export required by Pi 1.1.0. This override does not change the host’s packages. Host-provided Pi packages must remain wildcard (`"*"`) peer dependencies and must not be bundled, as the Pi package guide requires. The supported minimum belongs in compatibility documentation, runtime checks, and checker prerequisite validation, not in those peer ranges. Verify the real Pi session and provider-adapter integration on the minimum version and newer compatible releases; a version check alone does not prove compatibility. When raising the minimum, record the reason and update this decision, the compatibility checks, documentation, and tests together.

The old comparison tools and their rehearsals are now archived privately. The public live cache-reuse checker uses `scripts/pi-compatibility.ts` to enforce the minimum.

