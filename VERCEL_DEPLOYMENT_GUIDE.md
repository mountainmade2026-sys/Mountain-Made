# 🚀 Deploy Mount Made to Vercel

## Prerequisites
- Vercel account (free): https://vercel.com/signup
- Git installed
- Your project pushed to GitHub (recommended)

---

## Step 1: Setup PostgreSQL Database

Vercel doesn't include PostgreSQL. Use one of these **FREE** options:

### Option A: Neon (Recommended - Free Tier)
1. Go to: https://neon.tech/
2. Sign up and create a new project
3. Copy the connection string (looks like: `postgresql://user:pass@host/dbname`)
4. Save it for Step 3

### Option B: Supabase (Free Tier)
1. Go to: https://supabase.com/
2. Create new project
3. Go to Settings > Database > Connection String
4. Copy the connection string

### Option C: ElephantSQL (Free 20MB)
1. Go to: https://www.elephantsql.com/
2. Create "Tiny Turtle" free plan
3. Copy the URL

---

## Step 2: Install Vercel CLI

```bash
npm install -g vercel
```

---

## Step 3: Deploy to Vercel

### Method 1: Using Vercel CLI (Fastest)

```bash
# Login to Vercel
vercel login

# Deploy from your project directory
cd D:\mountain-made-ecommerce
vercel

# Follow the prompts:
# - Set up and deploy? Y
# - Which scope? (your account)
# - Link to existing project? N
# - Project name? mountain-made-ecommerce
# - Directory? ./ (press Enter)
# - Override settings? N
```

**After first deployment, add environment variables:**

```bash
# Set database connection
vercel env add DB_HOST
# Enter your database host (from connection string)

vercel env add DB_PORT
# Enter: 5432

vercel env add DB_USER
# Enter your database username

vercel env add DB_PASSWORD
# Enter your database password

vercel env add DB_NAME
# Enter your database name

vercel env add JWT_SECRET
# Enter: your-super-secret-jwt-key-change-this-in-production

vercel env add ADMIN_EMAIL
# Enter: admin@mountainmade.com

vercel env add ADMIN_PASSWORD
# Enter: Admin@123
```

**Redeploy with environment variables:**

```bash
vercel --prod
```

### Method 2: Using GitHub (Recommended for continuous deployment)

1. **Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR-USERNAME/mountain-made-ecommerce.git
   git push -u origin main
   ```

2. **Connect to Vercel:**
   - Go to: https://vercel.com/new
   - Click "Import Git Repository"
   - Select your GitHub repository
   - Click "Import"

3. **Add Environment Variables:**
   - In Vercel dashboard, go to: Settings > Environment Variables
   - Add these variables (one by one):
     ```
     DB_HOST=your-postgres-host.neon.tech
     DB_PORT=5432
     DB_USER=your-db-username
     DB_PASSWORD=your-db-password
     DB_NAME=mountain_made
     JWT_SECRET=your-super-secret-jwt-key-change-this
     ADMIN_EMAIL=admin@mountainmade.com
     ADMIN_PASSWORD=Admin@123
     ```

4. **Redeploy:**
   - Go to Deployments tab
   - Click "..." on latest deployment > Redeploy

---

## Step 4: Get Your Live URL

After deployment, you'll get a URL like:
```
https://mountain-made-ecommerce.vercel.app
```

Or you can use a custom domain!

---

## Step 5: Update .env file (for local development)

Create `.env` file with your database credentials:

```env
DB_HOST=your-postgres-host.neon.tech
DB_PORT=5432
DB_USER=your-db-username
DB_PASSWORD=your-db-password
DB_NAME=mountain_made
JWT_SECRET=your-super-secret-jwt-key-change-this
ADMIN_EMAIL=admin@mountainmade.com
ADMIN_PASSWORD=Admin@123
```

---

## Step 6: Test Your Deployment

Visit your Vercel URL:
- Homepage: `https://your-app.vercel.app/`
- Admin: `https://your-app.vercel.app/admin`
- Products: `https://your-app.vercel.app/products`

---

## Step 7: Create APK with Your Vercel URL

### Update manifest.json:

Edit `public/manifest.json`:
```json
{
  "name": "Mount Made E-Commerce",
  "short_name": "Mount Made",
  "start_url": "https://your-app.vercel.app/",
  ...
}
```

### Use PWABuilder:

1. Go to: https://www.pwabuilder.com/
2. Enter your Vercel URL: `https://your-app.vercel.app`
3. Click "Start"
4. Click "Package For Stores" > Android
5. Fill in:
   - Package ID: `com.mountainmade.app`
   - App name: `Mount Made`
6. Click "Generate"
7. Download your APK!

---

## 🎉 Common Issues & Solutions

### Issue: "Error connecting to database"
**Solution:** Check environment variables are set correctly in Vercel dashboard

### Issue: "502 Bad Gateway"
**Solution:** Check Vercel logs: `vercel logs` or in dashboard > Deployments > View Logs

### Issue: "Module not found"
**Solution:** Make sure all dependencies are in package.json, then redeploy

### Issue: File uploads not working
**Solution:** Vercel's filesystem is read-only. For file uploads, use:
- Cloudinary (free tier): https://cloudinary.com/
- Uploadcare: https://uploadcare.com/
- AWS S3

To integrate Cloudinary for images:
```bash
npm install cloudinary multer-storage-cloudinary
```

---

## 📊 Database Management

### View your database:
- **Neon**: Use their built-in SQL editor
- **Supabase**: Use Table Editor in dashboard
- **ElephantSQL**: Use their browser-based SQL console

### Run migrations:
```bash
# Connect to your production database
vercel env pull .env.production
# Then use a DB client like pgAdmin or DBeaver
```

---

## 🔄 Continuous Deployment

Once connected to GitHub:
1. Make changes locally
2. Commit: `git commit -am "Your changes"`
3. Push: `git push`
4. Vercel automatically deploys!

---

## 💰 Costs

- **Vercel**: Free for hobby projects (generous limits)
- **Neon/Supabase/ElephantSQL**: Free tier (3GB+ storage)
- **Total**: $0/month for small-medium traffic

---

## 🎯 Next Steps

1. ✅ Deploy to Vercel
2. ✅ Get your live URL
3. ✅ Create APK using PWABuilder with your Vercel URL
4. ✅ Install APK on Android phone
5. 🚀 Your app is live and fully dynamic!

---

## Quick Deploy Commands

```bash
# First time setup
vercel login
vercel

# Add environment variables (after first deploy)
vercel env add DB_HOST
vercel env add DB_PORT
vercel env add DB_USER
vercel env add DB_PASSWORD
vercel env add DB_NAME
vercel env add JWT_SECRET

# Deploy to production
vercel --prod

# View logs
vercel logs

# Check domains
vercel domains
```

---

## Need Help?

Run into issues? Common fixes:
```bash
# Clear Vercel cache and redeploy
vercel --force

# Check build logs
vercel logs --follow

# List environment variables
vercel env ls
```

Good luck! 🎉
