# Support Pi 1.0.2 and newer

An exact Pi 1.0.2 check in the former comparison script made optional rehearsals fail after a global Pi upgrade, even though the repository's development dependencies remain pinned. Support Pi >=1.0.2, and raise the minimum only when a breaking change requires a higher version. This lets users upgrade Pi while keeping a reproducible baseline for development.

Development dependencies may stay pinned. Host-provided Pi packages must remain wildcard (`"*"`) peer dependencies and must not be bundled, as the Pi package guide requires. The supported minimum belongs in compatibility documentation, runtime checks, and checker prerequisite validation, not in those peer ranges. Verify the real Pi session and provider-adapter integration on the minimum version and newer compatible releases; a version check alone does not prove compatibility. When a breaking change forces a higher minimum, record the incompatibility and update this decision, the compatibility checks, documentation, and tests together.

The old comparison tools and their rehearsals are now archived privately. The public live cache-reuse checker uses `scripts/pi-compatibility.ts` to enforce the minimum.

