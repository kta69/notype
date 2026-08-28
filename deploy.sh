#!/bin/bash
# GitHub Pages に公開して、どこからでもスマホで開けるようにするスクリプト
# 使い方:  bash deploy.sh
set -e
cd "$(dirname "$0")"

REPO="notype"

command -v gh >/dev/null || { echo "gh が未インストールです: brew install gh"; exit 1; }

if ! gh auth status >/dev/null 2>&1; then
  echo "▶ GitHub にログインします（ブラウザが開きます）"
  gh auth login --web --git-protocol https
fi

gh auth setup-git >/dev/null 2>&1 || true
USER=$(gh api user --jq .login)

git init -q 2>/dev/null || true
git config user.name  >/dev/null 2>&1 || git config user.name  "$USER"
git config user.email >/dev/null 2>&1 || git config user.email "$USER@users.noreply.github.com"
git add -A
git commit -q -m "Update NoType voice input app" || echo "（変更なし）"
git branch -M main

if gh repo view "$USER/$REPO" >/dev/null 2>&1; then
  git remote add origin "https://github.com/$USER/$REPO.git" 2>/dev/null || true
  git push -u origin main
else
  gh repo create "$REPO" --public --source=. --push
fi

gh api -X POST "repos/$USER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || gh api -X PUT "repos/$USER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true

echo ""
echo "=========================================="
echo " 公開URL（反映まで1〜2分）:"
echo "   https://$USER.github.io/$REPO/"
echo "=========================================="
echo " iPhone: Safari で開く → 共有ボタン → ホーム画面に追加"
