# Plausible Analytics with Lightform

This example demonstrates how to deploy [Plausible Analytics](https://plausible.io/) Community Edition using Lightform. Plausible is a privacy-focused, open-source web analytics tool that requires no cookies and is fully compliant with GDPR, CCPA, and PECR.

## Architecture

This setup includes:
- **Plausible**: The main analytics application
- **PostgreSQL**: Primary database for user data and settings
- **ClickHouse**: Events database for analytics data storage

## Prerequisites

1. A server with Docker installed (Lightform can handle this automatically)
2. A domain name pointing to your server
3. SSL certificates (handled automatically by Lightform)

## Quick Start

1. **Clone this example:**
   ```bash
   cp -r examples/plausible my-plausible-analytics
   cd my-plausible-analytics
   ```

2. **Configure your deployment:**
   - Edit `lightform.yml` and replace `your-server.com` with your actual server IP/domain
   - Update the `BASE_URL` in `.lightform/secrets` with your analytics domain

3. **Set up secrets:**
   ```bash
   # Generate required secrets
   SECRET_KEY_BASE=$(openssl rand -base64 48)
   TOTP_VAULT_KEY=$(openssl rand -base64 32)
   POSTGRES_PASSWORD=$(openssl rand -base64 32)
   
   # Edit .lightform/secrets with your values
   nano .lightform/secrets
   ```

4. **Deploy to your server:**
   ```bash
   lightform setup    # First time only - sets up server
   lightform deploy   # Deploy the application
   ```

## Configuration

### Required Environment Variables

Edit `.lightform/secrets` with your actual values:

- `BASE_URL`: Your analytics domain (e.g., `https://analytics.yourdomain.com`)
- `SECRET_KEY_BASE`: Generate with `openssl rand -base64 48`
- `TOTP_VAULT_KEY`: Generate with `openssl rand -base64 32`
- `POSTGRES_PASSWORD`: Database password

### Optional Configuration

Uncomment and configure in `.lightform/secrets` as needed:

**Email Configuration:**
```bash
MAILER_ADAPTER=Smtp
MAILER_EMAIL=hello@yourdomain.com
SMTP_HOST_ADDR=smtp.yourdomain.com
SMTP_HOST_PORT=587
SMTP_USER_NAME=hello@yourdomain.com
SMTP_USER_PWD=your-smtp-password
SMTP_HOST_SSL_ENABLED=true
```

**Google OAuth:**
```bash
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

**IP Geolocation:**
```bash
MAXMIND_LICENSE_KEY=your-maxmind-license-key
MAXMIND_EDITION=GeoLite2-City
```

## First-Time Setup

1. **Create your admin account:**
   After deployment, visit your analytics domain and create your first admin account.

2. **Add your website:**
   - Click "Add a website" in the dashboard
   - Enter your website domain
   - Copy the tracking script to your website's `<head>` section

3. **Configure tracking:**
   Add this script to your website:
   ```html
   <script defer data-domain="yourdomain.com" src="https://analytics.yourdomain.com/js/script.js"></script>
   ```

## Monitoring and Maintenance

### Check deployment status:
```bash
lightform status
```

### View logs:
```bash
# Plausible application logs
ssh lightform@your-server.com "docker logs plausible"

# Database logs
ssh lightform@your-server.com "docker logs plausible_db"

# ClickHouse logs
ssh lightform@your-server.com "docker logs plausible_events_db"
```

### Backup data:
```bash
# Backup PostgreSQL database
ssh lightform@your-server.com "docker exec plausible_db pg_dump -U postgres plausible_db > plausible_backup.sql"

# Backup ClickHouse data
ssh lightform@your-server.com "docker exec plausible_events_db clickhouse-client --query 'BACKUP DATABASE plausible_events_db TO Disk('default', 'backup.zip')'"
```

## Troubleshooting

### Common Issues

1. **Database connection errors:**
   - Check that PostgreSQL is healthy: `docker exec plausible_db pg_isready -U postgres`
   - Verify database URLs in secrets file

2. **ClickHouse connection errors:**
   - Check ClickHouse health: `docker exec plausible_events_db wget --no-verbose --tries=1 -O - http://127.0.0.1:8123/ping`
   - Verify ClickHouse is listening on correct port

3. **SSL certificate issues:**
   - Lightform automatically handles SSL certificates
   - Check domain DNS points to your server
   - Verify `BASE_URL` matches your domain

### Performance Tuning

For high-traffic sites, consider:
- Increasing server resources
- Adjusting ClickHouse memory settings in `clickhouse/low-resources.xml`
- Setting up multiple servers for load balancing

## Security Considerations

- Registration is disabled by default (`DISABLE_REGISTRATION=true`)
- Email verification is disabled for simplicity
- All data is stored on your servers
- No external tracking or data sharing
- GDPR/CCPA compliant by design

## Updating

To update Plausible:
1. Edit `lightform.yml` and change the image version
2. Run `lightform deploy` for zero-downtime update

## Support

- [Plausible Documentation](https://plausible.io/docs)
- [Lightform Documentation](https://lightform.dev)
- [Plausible Community Edition](https://github.com/plausible/community-edition)