#!/bin/bash
# Copy latest data to docs/
mkdir -p docs/data
cp data/portfolio.json docs/data/portfolio.json
cp data/metadata.json docs/data/metadata.json
# Commit and push
git add docs/
git commit -m "Update dashboard data $(date +%Y-%m-%d)"
git push origin main
