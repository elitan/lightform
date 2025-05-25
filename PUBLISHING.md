# 📦 Luma Publishing & Release Guide

This guide explains how to publish and manage releases for the Luma package on npmjs.org using Bun.

## 🚀 Quick Reference

### **First Time Publishing**

```bash
git pull origin main
bun run publish:current
```

### **Regular Releases**

```bash
# Bug fixes
bun run release:patch

# New features
bun run release:minor

# Breaking changes
bun run release:major
```

### **Pre-releases**

```bash
bun run release:alpha    # Alpha version
bun run release:beta     # Beta version
bun run release:rc       # Release candidate
```

### **Testing**

```bash
bun run publish:dry-run  # See what would be published
bun run version:check    # Check current version
```

---

## 📋 Available Bun Scripts

| Script                    | Purpose                      | Version Change | Example                       |
| ------------------------- | ---------------------------- | -------------- | ----------------------------- |
| `bun run publish:current` | Publish without version bump | None           | 0.1.0 → 0.1.0 (published)     |
| `bun run release:patch`   | Bug fix release              | PATCH          | 0.1.0 → 0.1.1                 |
| `bun run release:minor`   | Feature release              | MINOR          | 0.1.0 → 0.2.0                 |
| `bun run release:major`   | Breaking changes             | MAJOR          | 0.1.0 → 1.0.0                 |
| `bun run release:alpha`   | Alpha pre-release            | PRERELEASE     | 0.1.0 → 0.1.1-alpha.0         |
| `bun run release:beta`    | Beta pre-release             | PRERELEASE     | 0.1.0 → 0.1.1-beta.0          |
| `bun run release:rc`      | Release candidate            | PRERELEASE     | 0.1.0 → 0.1.1-rc.0            |
| `bun run publish:dry-run` | Test publish (safe)          | None           | Shows what would be published |
| `bun run version:check`   | Show version info            | None           | Displays current version      |

---

## 🔢 Semantic Versioning (SemVer)

Luma follows semantic versioning: `MAJOR.MINOR.PATCH`

### **PATCH** (0.1.0 → 0.1.1)

- Bug fixes
- Security patches
- Documentation updates
- Performance improvements (no API changes)

### **MINOR** (0.1.0 → 0.2.0)

- New features
- New command line options
- Backwards compatible changes
- Deprecating features (not removing)

### **MAJOR** (0.1.0 → 1.0.0)

- Breaking changes
- Removing deprecated features
- Changing command line interface
- Incompatible API changes

---

## 🛠️ Step-by-Step Workflows

### Workflow 1: First Time Publishing

1. **Ensure you're logged into npm (Bun uses npm registry):**

   ```bash
   bun pm login  # or: npm whoami
   ```

2. **Make sure main branch is up to date:**

   ```bash
   git checkout main
   git pull origin main
   ```

3. **Test the build:**

   ```bash
   bun run build
   bun run publish:dry-run
   ```

4. **Publish:**

   ```bash
   bun run publish:current
   ```

5. **Verify publication:**
   ```bash
   bun pm view @elitan/luma
   ```

### Workflow 2: Bug Fix Release

1. **Make your bug fixes and commit:**

   ```bash
   git add .
   git commit -m "fix: resolve deployment timeout issue"
   git push origin main
   ```

2. **Release patch version:**

   ```bash
   bun run release:patch
   ```

3. **That's it!** The script automatically:
   - Bumps version (0.1.0 → 0.1.1)
   - Creates git tag
   - Pushes to GitHub
   - Builds and publishes to npm

### Workflow 3: Feature Release

1. **Add your new feature and commit:**

   ```bash
   git add .
   git commit -m "feat: add rollback command"
   git push origin main
   ```

2. **Release minor version:**

   ```bash
   bun run release:minor
   ```

3. **Version bumped:** 0.1.0 → 0.2.0

### Workflow 4: Breaking Changes

1. **Make breaking changes and commit:**

   ```bash
   git add .
   git commit -m "feat!: redesign configuration format"
   git push origin main
   ```

2. **Release major version:**

   ```bash
   bun run release:major
   ```

3. **Version bumped:** 0.1.0 → 1.0.0

### Workflow 5: Pre-release Testing

1. **Make changes and commit:**

   ```bash
   git add .
   git commit -m "feat: experimental blue-green improvements"
   git push origin main
   ```

2. **Release beta version:**

   ```bash
   bun run release:beta
   ```

3. **Install and test:**

   ```bash
   bun add -g @elitan/luma@beta
   luma --version  # Shows: 0.1.1-beta.0
   ```

4. **When ready, promote to stable:**
   ```bash
   bun run release:minor  # Creates 0.2.0
   ```

---

## 🎯 Common Scenarios

### Scenario: "I fixed a bug"

```bash
bun run release:patch
```

### Scenario: "I added a new command"

```bash
bun run release:minor
```

### Scenario: "I changed how configuration works"

```bash
bun run release:major
```

### Scenario: "I want to test changes before official release"

```bash
bun run release:beta
```

### Scenario: "I want to see what would be published"

```bash
bun run publish:dry-run
```

### Scenario: "I just want to publish current version"

```bash
bun run publish:current
```

---

## 🔍 Verification Commands

After publishing, verify everything worked:

```bash
# Check if package exists and view info
bun pm view @elitan/luma

# See all available versions
bun pm view @elitan/luma --versions

# Install globally and test
bun add -g @elitan/luma@latest
luma --version

# Check package page
open https://www.npmjs.com/package/@elitan/luma
```

---

## 🚨 Troubleshooting

### "Error: 403 Forbidden"

- Make sure you're logged in: `bun pm login` or `npm whoami`
- Make sure you have permission to publish `@elitan/luma`

### "Error: Version already exists"

- You're trying to publish a version that already exists
- Bump the version first with one of the release scripts

### "Git working directory not clean"

- Commit your changes first: `git add . && git commit -m "your message"`
- Or stash them: `git stash`

### "Can't push to main"

- Make sure you have push access to the repository
- Try: `git push origin main --tags`

---

## 📚 Additional Resources

- **NPM Package:** https://www.npmjs.com/package/@elitan/luma
- **GitHub Repository:** https://github.com/elitan/luma
- **Semantic Versioning:** https://semver.org/
- **Bun Publishing Guide:** https://bun.sh/docs/cli/publish

---

## 🎉 That's It!

Just remember:

- **Bug fix?** → `bun run release:patch`
- **New feature?** → `bun run release:minor`
- **Breaking change?** → `bun run release:major`
- **Want to test first?** → `bun run release:beta`

The scripts handle everything else automatically! 🚀
