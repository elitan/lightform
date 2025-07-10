# Next.js + Lightform Deployment Example

This is a [Next.js](https://nextjs.org) project that demonstrates zero-downtime deployments using [Lightform](https://github.com/elitan/lightform).

## 🚀 Quick Start with Lightform

### 1. Development Setup

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### 2. Deploy with Lightform

This example includes a complete Lightform configuration for zero-downtime deployment:

```bash
# Set up your servers
lightform setup

# Deploy with zero downtime!
lightform deploy
```

## 🐳 Docker Configuration

The included `Dockerfile` is optimized for Next.js deployments with Lightform:

### Features

- **Multi-stage build**: Optimized for production with minimal image size
- **Standalone output**: Uses Next.js standalone mode for efficient containerization
- **Security**: Runs as non-root user
- **Cache optimization**: Leverages Docker layer caching for faster builds

## 📚 Learn More

### Next.js Resources

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial

### Lightform Resources

- [Lightform Documentation](https://github.com/elitan/lightform) - zero-downtime Docker deployments
- [Lightform Examples](https://github.com/elitan/lightform/tree/main/examples) - more deployment examples

## 🆚 Why Lightform vs Vercel?

- **Your own servers** - full control, no vendor lock-in
- **Cost-effective** - pay only for your servers, not per deployment
- **No cold starts** - your containers are always running
- **Zero-downtime deployments** - blue-green deployments out of the box
- **Automatic SSL** - Let's Encrypt certificates managed automatically

---

**This example demonstrates how easy it is to deploy Next.js applications with zero downtime using Lightform! 🚀**
