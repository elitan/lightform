# 📦 Luma Publishing & Release Guide

This guide explains how to publish and manage releases for the Luma package on npmjs.org.

## 🚀 Quick Reference

### **First Time Publishing**

```bash
git pull origin main
npm run publish:current
```

### **Regular Releases**

```bash
# Bug fixes
npm run release:patch

# New features
npm run release:minor

# Breaking changes
npm run release:major
```

### **Pre-releases**

```bash
npm run release:alpha    # Alpha version
npm run release:beta     # Beta version
npm run release:rc       # Release candidate
```

### **Testing**

```bash
npm run publish:dry-run  # See what would be published
npm run version:check    # Check current version
```

---

## 📋 Available NPM Scripts

| Script                    | Purpose                      | Version Change | Example                       |
| ------------------------- | ---------------------------- | -------------- | ----------------------------- |
| `npm run publish:current` | Publish without version bump | None           | 0.1.0 → 0.1.0 (published)     |
| `npm run release:patch`   | Bug fix release              | PATCH          | 0.1.0 → 0.1.1                 |
| `npm run release:minor`   | Feature release              | MINOR          | 0.1.0 → 0.2.0                 |
| `npm run release:major`   | Breaking changes             | MAJOR          | 0.1.0 → 1.0.0                 |
| `npm run release:alpha`   | Alpha pre-release            | PRERELEASE     | 0.1.0 → 0.1.1-alpha.0         |
| `npm run release:beta`    | Beta pre-release             | PRERELEASE     | 0.1.0 → 0.1.1-beta.0          |
| `npm run release:rc`      | Release candidate            | PRERELEASE     | 0.1.0 → 0.1.1-rc.0            |
| `npm run publish:dry-run` | Test publish (safe)          | None           | Shows what would be published |
| `npm run version:check`   | Show version info            | None           | Displays current version      |

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

1. **Ensure you're logged into npm:**

   ```bash
   npm whoami  # Should show: elitan
   ```

2. **Make sure main branch is up to date:**

   ```bash
   git checkout main
   git pull origin main
   ```

3. **Test the build:**

   ```bash
   npm run build
   npm run publish:dry-run
   ```

4. **Publish:**

   ```bash
   npm run publish:current
   ```

5. **Verify publication:**
   ```bash
   npm view @elitan/luma
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
   npm run release:patch
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
   npm run release:minor
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
   npm run release:major
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
   npm run release:beta
   ```

3. **Install and test:**

   ```bash
   npm install -g @elitan/luma@beta
   luma --version  # Shows: 0.1.1-beta.0
   ```

4. **When ready, promote to stable:**
   ```bash
   npm run release:minor  # Creates 0.2.0
   ```

---

## 🎯 Common Scenarios

### Scenario: "I fixed a bug"

```bash
npm run release:patch
```

### Scenario: "I added a new command"

```bash
npm run release:minor
```

### Scenario: "I changed how configuration works"

```bash
npm run release:major
```

### Scenario: "I want to test changes before official release"

```bash
npm run release:beta
```

### Scenario: "I want to see what would be published"

```bash
npm run publish:dry-run
```

### Scenario: "I just want to publish current version"

```bash
npm run publish:current
```

---

## 🔍 Verification Commands

After publishing, verify everything worked:

```bash
# Check if package exists and view info
npm view @elitan/luma

# See all available versions
npm view @elitan/luma versions --json

# Install globally and test
npm install -g @elitan/luma@latest
luma --version

# Check package page
open https://www.npmjs.com/package/@elitan/luma
```

---

## 🚨 Troubleshooting

### "npm ERR! 403 Forbidden"

- Make sure you're logged in: `npm whoami`
- Make sure you have permission to publish `@elitan/luma`

### "npm ERR! Version already exists"

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
- **NPM Publishing Guide:** https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry

---

## 🎉 That's It!

Just remember:

- **Bug fix?** → `npm run release:patch`
- **New feature?** → `npm run release:minor`
- **Breaking change?** → `npm run release:major`
- **Want to test first?** → `npm run release:beta`

The scripts handle everything else automatically! 🚀
