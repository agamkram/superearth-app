#!/bin/bash
cd "$(dirname "$0")"

export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_ed25519_github -o IdentitiesOnly=yes"

git add -A

if ! git diff --cached --quiet; then
  git commit -m "Update $(date '+%Y-%m-%d %H:%M')"
  echo "Committed local changes."
else
  echo "No local changes to commit."
fi

echo ""
echo "Pushing to github.com/agamkram/superearth-app ..."
git push -u origin main

if [ $? -eq 0 ]; then
  echo ""
  echo "Done. Vercel should redeploy in about a minute."
else
  echo ""
  echo "Push failed."
  echo "If the repo does not exist yet, create it at https://github.com/new"
  echo "Name: superearth-app (empty — no README)"
fi

echo ""
read -r -p "Press Enter to close..."
