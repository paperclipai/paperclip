# DIYBrand Board Setup Guide

**For:** Domain registration, Vercel setup, and GitHub secrets configuration
**Timeline:** 2-3 hours total
**Owner:** Board/Leadership
**Paperclip Issues:** DIY-51, DIY-52, DIY-53

---

## Phase 1: Domain Registration (DIY-51)
**Estimated Time:** 1-2 hours
**Owner:** Board member with credit card access

### Step 1.1: Choose Domain Registrar
Pick one:
- **Namecheap** (recommended, cheap, easy)
- **GoDaddy** (popular, easy)
- **Google Domains** (integrates with Google Cloud)
- **Cloudflare** (if using Cloudflare nameservers)

### Step 1.2: Register Domain
1. Go to registrar website
2. Search for: `diybrand.app`
3. Add to cart
4. Complete checkout with credit card
5. **Save the nameservers** provided by registrar (you'll need these in Step 2)

### Step 1.3: Verify Registration
1. Check email for domain confirmation
2. Confirm domain ownership if required
3. Note the nameservers in registrar account

**✓ DIY-51 Complete** — Domain registered and nameservers noted

---

## Phase 2: Vercel Project Setup (DIY-52)
**Estimated Time:** 30 minutes
**Owner:** Board member with Vercel/GitHub access
**Dependency:** DIY-51 (domain registered)

### Step 2.1: Create Vercel Account
1. Go to https://vercel.com
2. Click "Sign Up"
3. Choose: "Continue with GitHub"
4. Authorize Vercel to access your GitHub account
5. Create Vercel team/account

### Step 2.2: Import GitHub Repository
1. In Vercel dashboard, click "Add New..." → "Project"
2. Select: "Import Git Repository"
3. Search for: `diybrand` or your repo name
4. Select: `/home/alfred/paperclip/workspace/diybrand`
5. Click "Import"

### Step 2.3: Configure Project Settings
1. **Project name:** `diybrand`
2. **Framework preset:** Next.js (should auto-detect)
3. **Root directory:** `./` (leave as is)
4. **Build command:** `npm run build` (auto-detected)
5. **Output directory:** `.next` (auto-detected)

### Step 2.4: Environment Variables (Skip for now)
- Don't add environment variables yet
- We'll configure these in DIY-53 via GitHub secrets
- Click "Deploy" without environment variables

### Step 2.5: Wait for First Build
1. Vercel will start building your project
2. This may take 2-5 minutes
3. You'll see build logs in the dashboard
4. Build should succeed (if it fails, check error logs)

### Step 2.6: Save These Values
Once deployment completes, copy these from Vercel:
1. **VERCEL_ORG_ID** — Found in: Settings → General (copy "Team ID")
2. **VERCEL_PROJECT_ID** — Found in: Settings → General (copy "Project ID")
3. **VERCEL_TOKEN** — Create new token:
   - Go to: Settings → Tokens
   - Click "Create Token"
   - Name: `github-actions`
   - Scope: Full Access
   - Copy the token (you won't see it again)

### Step 2.7: Connect Custom Domain
1. In Vercel project, go to: Settings → Domains
2. Click "Add Domain"
3. Enter: `diybrand.app`
4. Choose: "Use Namespaced DNS"
5. Vercel will show you nameservers to add to your registrar:
   - `ns1.vercel-dns.com`
   - `ns2.vercel-dns.com`
   - `ns3.vercel-dns.com`
   - `ns4.vercel-dns.com`

### Step 2.8: Update Domain Registrar
1. Go back to your domain registrar (Namecheap, GoDaddy, etc.)
2. Find: "Manage Domain" or "Nameservers"
3. Replace existing nameservers with Vercel nameservers:
   - `ns1.vercel-dns.com`
   - `ns2.vercel-dns.com`
   - `ns3.vercel-dns.com`
   - `ns4.vercel-dns.com`
4. Save/Update nameservers
5. **Wait 24-48 hours** for DNS propagation (can be instant, usually within 1 hour)

**✓ DIY-52 Complete** — Vercel project created, domain connected, values saved

---

## Phase 3: GitHub Secrets Configuration (DIY-53)
**Estimated Time:** 15-30 minutes
**Owner:** Board member with GitHub access
**Dependency:** DIY-52 (Vercel setup complete, values saved)

### Step 3.1: Open GitHub Repository Settings
1. Go to: https://github.com/[your-org]/diybrand
2. Click: Settings (gear icon)
3. Click: Secrets and variables → Actions

### Step 3.2: Add VERCEL_ORG_ID
1. Click "New repository secret"
2. **Name:** `VERCEL_ORG_ID`
3. **Value:** (paste the ID from DIY-52 Step 2.6)
4. Click "Add secret"

### Step 3.3: Add VERCEL_PROJECT_ID
1. Click "New repository secret"
2. **Name:** `VERCEL_PROJECT_ID`
3. **Value:** (paste the ID from DIY-52 Step 2.6)
4. Click "Add secret"

### Step 3.4: Add VERCEL_TOKEN
1. Click "New repository secret"
2. **Name:** `VERCEL_TOKEN`
3. **Value:** (paste the token from DIY-52 Step 2.6)
4. Click "Add secret"

### Step 3.5: Add Other Required Secrets
Add these secrets (values provided by your team):

**SENTRY_DSN**
- Value: (ask your team for this)
- Used for: Error tracking

**STRIPE_SECRET_KEY**
- Value: (ask your team for this)
- Used for: Payment processing

**DATABASE_URL** (if applicable)
- Value: (ask your team for this)
- Used for: Database connection

### Step 3.6: Verify All Secrets Added
1. In "Secrets and variables → Actions", verify you see:
   - ✅ VERCEL_ORG_ID
   - ✅ VERCEL_PROJECT_ID
   - ✅ VERCEL_TOKEN
   - ✅ SENTRY_DSN
   - ✅ STRIPE_SECRET_KEY
   - ✅ DATABASE_URL

**✓ DIY-53 Complete** — All secrets configured

---

## Phase 4: First Deployment (DIY-54)
**Estimated Time:** 1-2 hours
**Owner:** Atlas (DevOps) with board monitoring
**Dependency:** DIY-51, DIY-52, DIY-53 complete

Once DIY-51-53 are complete, Atlas will:
1. Push infrastructure code to main
2. GitHub Actions CI/CD pipeline will trigger
3. Run lint, test, build checks
4. Deploy to Vercel production
5. Validate domain, SSL, error tracking
6. Monitor uptime and error rates

**Success Criteria:**
- ✅ https://diybrand.app loads successfully
- ✅ SSL certificate valid (green lock)
- ✅ Error tracking working (Sentry)
- ✅ Uptime monitoring active
- ✅ No critical errors in logs

---

## Troubleshooting

### DNS Not Propagating
- **Problem:** Domain not resolving after 1 hour
- **Solution:**
  1. Verify nameservers in registrar are correct
  2. Wait another 24 hours (DNS can take up to 48 hours)
  3. Check with: https://www.whatsmydns.net/?q=diybrand.app

### Vercel Build Fails
- **Problem:** Build shows error
- **Solution:**
  1. Check Vercel build logs for error messages
  2. Verify all environment variables are set in GitHub (DIY-53)
  3. Contact Atlas for debugging

### GitHub Actions Doesn't Trigger
- **Problem:** Push to main doesn't start CI/CD
- **Solution:**
  1. Verify all secrets are configured (DIY-53)
  2. Check GitHub Actions tab for errors
  3. Contact Atlas for debugging

### SSL Certificate Errors
- **Problem:** Browser shows certificate warning
- **Solution:**
  1. Wait for DNS to fully propagate (can take 1 hour)
  2. Vercel automatically provisions SSL once domain resolves
  3. Refresh browser after 30 minutes

---

## Quick Reference

| Task | Owner | Time | Status |
|------|-------|------|--------|
| Register domain | Board | 1-2h | DIY-51 |
| Create Vercel project | Board | 30m | DIY-52 |
| Configure GitHub secrets | Board | 15-30m | DIY-53 |
| First deployment | Atlas | 1-2h | DIY-54 |
| **Total** | **Mixed** | **4-6h** | **Ready** |

---

## Contact & Support

**For questions during setup:**
- Domain issues → Contact registrar support
- Vercel issues → Check Vercel docs or contact Vercel support
- GitHub/deployment issues → Contact Atlas

**Success Signal:**
Once all three phases complete, Atlas will automatically begin DIY-54 (first production deployment) and notify the board.

---

**Created by Atlas**
**For DIYBrand Production Launch**
**2026-03-20**
