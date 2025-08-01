# Release Process

This document outlines the automated release process for iop.

## 🚀 Quick Release

```bash
# Patch release (0.2.5 → 0.2.6)
bun run release

# Minor release (0.2.5 → 0.3.0) 
bun run release:minor

# Major release (0.2.5 → 1.0.0)
bun run release:major
```

## 🤖 What Happens Automatically

The release script (`scripts/release.sh`) performs these steps:

1. **Validation**
   - ✅ Checks you're on `main` branch
   - ✅ Ensures no uncommitted changes
   - ✅ Verifies GitHub CLI is installed and authenticated

2. **Version Management**  
   - ✅ Pulls latest changes from `main`
   - ✅ Bumps package version in `package.json`
   - ✅ Commits version bump with conventional commit message
   - ✅ Creates and pushes Git tag

3. **Publishing**
   - ✅ Builds TypeScript CLI package
   - ✅ Publishes to npm registry
   - ✅ Creates GitHub release with **auto-generated notes**

## 📝 Auto-Generated Release Notes

GitHub automatically generates release notes based on:

- **Merged Pull Requests** with proper categorization
- **Contributors** with first-time contributor recognition  
- **Commit history** between releases
- **Custom categories** defined in `.github/release.yml`

### PR Label Categories

Use these labels on PRs for automatic categorization:

| Label | Category | Example |
|-------|----------|---------|
| `breaking-change`, `breaking`, `major` | 🚨 Breaking Changes | API changes |
| `feature`, `enhancement`, `new-feature` | 🚀 New Features | New commands |
| `bug`, `bugfix`, `fix` | 🐛 Bug Fixes | Fix deployment issues |
| `documentation`, `docs` | 📚 Documentation | README updates |
| `maintenance`, `refactor`, `cleanup` | 🧹 Maintenance | Code refactoring |
| `infrastructure`, `ci`, `build` | 🔧 Infrastructure | CI improvements |
| `performance`, `optimization` | ⚡ Performance | Speed improvements |
| `security`, `vulnerability` | 🔒 Security | Security fixes |

### Excluded from Release Notes

- PRs labeled with: `chore`, `dependencies`, `ignore-for-release`
- Commits from: `dependabot`, `github-actions`

## 📋 Manual Release Checklist

When doing releases manually or debugging issues:

1. **Pre-Release**
   - [ ] All PRs properly labeled
   - [ ] Tests passing in CI
   - [ ] On `main` branch with clean working directory

2. **Release**
   - [ ] Run appropriate release command
   - [ ] Verify npm package published
   - [ ] Check GitHub release created
   - [ ] Verify release notes look good

3. **Post-Release**
   - [ ] Update any dependent projects
   - [ ] Announce release if significant
   - [ ] Close related issues/milestones

## 🔍 Troubleshooting

### "Not logged into GitHub CLI"
```bash
gh auth login
```

### "You have uncommitted changes"
```bash
git status
git add . && git commit -m "your message"
# or
git stash
```

### "Must be on main branch"
```bash
git checkout main
git pull origin main
```

### Release failed after npm publish
If the script fails after npm publish but before GitHub release:
```bash
# Manually create the GitHub release
gh release create v0.2.6 --generate-notes --latest
```

## 🎯 Best Practices

1. **Use descriptive PR titles** - they become changelog entries
2. **Label PRs appropriately** - enables proper categorization  
3. **Keep commits atomic** - easier to understand changes
4. **Test before releasing** - run `bun run build` and `bun run test`
5. **Follow semantic versioning**:
   - `patch`: Bug fixes, small improvements
   - `minor`: New features, non-breaking changes
   - `major`: Breaking changes

## 🔗 Links

- [GitHub Release Notes Documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Semantic Versioning](https://semver.org/)