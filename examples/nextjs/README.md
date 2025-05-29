# Next.js + Luma Deployment Example

This is a [Next.js](https://nextjs.org) project that demonstrates zero-downtime deployments using [Luma](https://github.com/elitan/luma).

## 🚀 Quick Start with Luma

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

### 2. Deploy with Luma

This example includes a complete Luma configuration for zero-downtime deployment:

```bash
# Set up your servers
luma setup

# Deploy with zero downtime!
luma deploy
```

## 🐳 Docker Configuration

The included `Dockerfile` is optimized for Next.js deployments with Luma:

### Features

- **Multi-stage build**: Optimized for production with minimal image size
- **Standalone output**: Uses Next.js standalone mode for efficient containerization
- **Security**: Runs as non-root user
- **Cache optimization**: Leverages Docker layer caching for faster builds

## 📚 Learn More

### Next.js Resources

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial

### Luma Resources

- [Luma Documentation](https://github.com/elitan/luma) - zero-downtime Docker deployments
- [Luma Examples](https://github.com/elitan/luma/tree/main/examples) - more deployment examples

## 🆚 Why Luma vs Vercel?

- **Your own servers** - full control, no vendor lock-in
- **Cost-effective** - pay only for your servers, not per deployment
- **No cold starts** - your containers are always running
- **Zero-downtime deployments** - blue-green deployments out of the box
- **Automatic SSL** - Let's Encrypt certificates managed automatically

---

**This example demonstrates how easy it is to deploy Next.js applications with zero downtime using Luma! 🚀**
