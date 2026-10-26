# RingHi macOS 0.4.5 — software validation

2026-10-26. Native SwiftUI/AppKit, Apple Silicon, macOS 13+. Ad-hoc signing only; no Developer ID notarization claim.

Changes: explicit direct-only URLSession proxy configuration; 60-second device activation response budget; retain acknowledged activation replies in Keychain before cancellation/USB writes; persist official completion despite concurrent cancellation. Never replay unknown device activation outcomes. ESP write/independent verification reuse the downloader without repeated USB resets. New Batch exclusively creates and synchronizes a new CSV before firmware/auth preparation; firmware snapshot preparation runs off the UI thread and scanning starts only once the prepared batch is accepted by the UI.

Validation: 158 isolated software checks passed, including direct proxy configuration, receiving an acknowledged device response after cancellation, existing-CSV preservation, failed CSV creation, scheduler/unplug, software protocol fixtures, full-digest evidence parsing and process cancellation. No hardware or cloud activation was performed by self-test.

Installed at the existing /Applications/RingHi Flasher.app path; previous app archived as ZIP. Three existing account/configuration/CSV files matched hashes during installation (Keychain retained in place). Actual installed UI displayed 0.4.5, automatically logged in and restored the selected project. New Batch immediately opened the CSV save dialog; cancelling returned to idle with no batch. Window close and reopen restored the same configuration.

Limits: no real-board flashing on this build; timeout handling and receipt storage are not proof of hardware recovery. Native Mac automatic updater remains unimplemented; use the provided PKG for in-place upgrades.
