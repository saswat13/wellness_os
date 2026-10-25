# Recovery storage fix after the launch catalog release

The full-catalog browser regression reproduced the live warning: adding a launch
exercise changes save status from Saved to Couldn't save before it can complete.
The journal repeats large shared-catalog strings across baseline, projected, pending
and in-flight snapshots, exceeding its existing 2,000,000-character serialized bound.
Navigation controls were also descendants of a disabled editing fieldset.

The frontend-only correction writes version-2 recovery envelopes with lossless JSON
string interning. The existing account-scoped `form-cloud-pending-v1:` keys are
unchanged. Version-1 envelopes remain readable, and opening one does not rewrite it;
a successful explicit write can use version 2. Revisions, mutation keys, receipts,
source snapshots and independent L/R values are reconstructed exactly, with no
source refresh/rebase or automatic mutation replay. No catalog records are omitted.
The stored size limit remains 2,000,000 characters. Decoding has depth, node and
expanded-string bounds; corrupt data fails closed. Storage is still private cleartext,
not encrypted by this encoding.

A representative four-snapshot launch-catalog payload shrinks from 2,662,449 to
1,246,211 characters. This does not guarantee sufficient quota on every device.
Actual storage failures still pause writes and expose a private download. The lease
advances its expected storage checkpoint only after read-back confirms the write,
so silently dropped writes do not prevent a subsequent safe retry.

Workout and Nutrition navigation now remain interactive when edits are locked.
Editing controls stay disabled, and navigation does not retry pending writes.
Account/recovery actions remain available. No automatic storage clearing was added.

## Release and protect current edits

This needs only the existing static-frontend publishing workflow. Preserve deployed
backend fixes and all catalog/user data; do not reseed, redeploy Lambda, modify IAM
or clear localStorage. Upload assets before HTML and verify the live build.

For an already-open failing tab, ask the user to download pending edits **before**
reloading or closing it. A frontend release cannot retrofit new JavaScript into an
old running tab. Its newer in-memory changes may not be in the last durable journal.
The download preserves private data but is not an implemented automatic backup-import
feature; do not promise that refreshing will restore unpersisted memory. Existing
valid on-device journals remain recoverable on the same authenticated account, with
explicit retry required. Never discard or replay pending edits without user intent.

Verify on the released frontend with the full 800-item catalog: create a workout,
add launch exercises, save notes, reload and confirm Saved. Also verify a simulated
lost response recovers without changing its idempotency key or If-Match revision.
The existing storage-failure browser check verifies disabled writes plus working
Workouts/Library and Nutrition/Foods navigation while keeping unsaved notes.
