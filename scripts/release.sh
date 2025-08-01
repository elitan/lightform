#!/bin/bash

# iop Release Script
# Handles version bumping, npm publishing, and GitHub releases with auto-generated notes

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [[ ! -f "packages/cli/package.json" ]]; then
    echo -e "${RED}Error: Must be run from the repository root${NC}"
    exit 1
fi

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}Error: GitHub CLI (gh) is required but not installed${NC}"
    echo -e "${YELLOW}Install with: brew install gh${NC}"
    exit 1
fi

# Check if logged into GitHub
if ! gh auth status &> /dev/null; then
    echo -e "${RED}Error: Not logged into GitHub CLI${NC}"
    echo -e "${YELLOW}Run: gh auth login${NC}"
    exit 1
fi

# Get the version type (patch, minor, major)
VERSION_TYPE=${1:-patch}

if [[ ! "$VERSION_TYPE" =~ ^(patch|minor|major)$ ]]; then
    echo -e "${RED}Error: Version type must be patch, minor, or major${NC}"
    echo "Usage: $0 [patch|minor|major]"
    exit 1
fi

echo -e "${BLUE}🚀 Starting iop release process...${NC}"

# Change to CLI directory
cd packages/cli

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${YELLOW}Current version: ${CURRENT_VERSION}${NC}"

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
    echo -e "${RED}Error: You have uncommitted changes. Please commit or stash them first.${NC}"
    exit 1
fi

# Ensure we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo -e "${RED}Error: You must be on the main branch to create a release${NC}"
    echo -e "${YELLOW}Current branch: ${CURRENT_BRANCH}${NC}"
    exit 1
fi

# Pull latest changes
echo -e "${YELLOW}Pulling latest changes...${NC}"
git pull origin main

# Bump version
echo -e "${YELLOW}Bumping ${VERSION_TYPE} version...${NC}"
NEW_VERSION=$(npm version $VERSION_TYPE --no-git-tag-version | sed 's/^v//')
echo -e "${GREEN}New version: ${NEW_VERSION}${NC}"

# Build the package
echo -e "${YELLOW}Building package...${NC}"
bun run build

# Commit version bump
cd ../..
git add packages/cli/package.json
git commit -m "chore: bump version to v${NEW_VERSION}"

# Create and push tag
echo -e "${YELLOW}Creating and pushing tag...${NC}"
git tag "v${NEW_VERSION}"
git push origin main --tags

# Publish to npm
echo -e "${YELLOW}Publishing to npm...${NC}"
cd packages/cli
npm publish
cd ../..

# Create GitHub release with auto-generated notes
echo -e "${YELLOW}Creating GitHub release with auto-generated notes...${NC}"
gh release create "v${NEW_VERSION}" \
    --title "v${NEW_VERSION}" \
    --generate-notes \
    --latest

echo
echo -e "${GREEN}✅ Release v${NEW_VERSION} completed successfully!${NC}"
echo -e "${GREEN}📦 npm: https://www.npmjs.com/package/iop/v/${NEW_VERSION}${NC}"
echo -e "${GREEN}🐙 GitHub: https://github.com/elitan/iop/releases/tag/v${NEW_VERSION}${NC}"
echo
echo -e "${BLUE}🎉 The release notes were auto-generated based on PRs and commits!${NC}"
echo -e "${BLUE}💡 Use labels on PRs (feature, bug, breaking-change, etc.) for better categorization${NC}"