# GitHub Copilot — repository instructions

These instructions apply to every Copilot CLI / agent session in this
repository. They are binding constraints, not suggestions.

## Git workflow — hard rules

* **Never force-push.** Do not run `git push --force`,
  `git push --force-with-lease`, `git push -f`, or any command that
  rewrites refs already on the remote. If a normal push is rejected,
  stop and surface the conflict to the user — do not work around it.
* **Never amend commits.** Do not run `git commit --amend`,
  `git commit -a --amend`, or any equivalent. Once a commit exists,
  treat it as immutable history. If a fix is needed, add a new commit
  on top.
* **No history rewrites.** Do not run `git rebase -i`, `git reset --hard`
  on shared branches, `git filter-branch`, `git filter-repo`, or
  `git reflog expire`. Use additive commits only.
* **Commit per partes.** When several unrelated changes accumulate in
  the working tree, split them into separate commits — one logical
  change per commit, with a focused message — before pushing.

If any rule above blocks your task, stop and ask the user instead of
finding a workaround.
