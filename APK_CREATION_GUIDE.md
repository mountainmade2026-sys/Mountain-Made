# APK Creation Guide for Mount Made E-Commerce

## ✅ EASIEST METHOD: PWABuilder (Recommended)

### Prerequisites:
1. Your backend must be hosted online (not localhost)
   - Options: Heroku, Railway, Render, DigitalOcean, AWS, etc.
   - Or use ngrok temporarily for testing: `npx ngrok http 3000`

### Steps:

1. **Host your backend online** (replace localhost URLs)

2. **Create app icons** (192x192 and 512x512 PNG):
   - Place them in `public/images/` as `icon-192.png` and `icon-512.png`
   - Or use this tool: https://realfavicongenerator.net/

3. **Visit PWABuilder**:
   - Go to: https://www.pwabuilder.com/
   - Enter your hosted website URL (e.g., `https://yourdomain.com`)
   - Click "Start"

4. **Generate APK**:
   - PWABuilder will analyze your PWA
   - Click "Package For Stores"
   - Select "Android"
   - Choose "Google Play Store" or "APK" download
   - Fill in package details (e.g., `com.MountMade.app`)
   - Click "Generate"
   - Download the APK or upload to Google Play

5. **Install on Android**:
   - Transfer APK to phone
   - Enable "Install from Unknown Sources"
   - Install the APK

---

## 🔧 OPTION 2: Capacitor (More Professional)

### Installation:

```bash
# Install Capacitor
npm install @capacitor/core @capacitor/cli
npm install @capacitor/android

# Initialize Capacitor
npx cap init "Mount Made" "com.MountMade.app" --web-dir=public

# Add Android platform
npx cap add android

# Update config
```

### Update capacitor.config.json:

```json
{
  "appId": "com.MountMade.app",
  "appName": "Mount Made",
  "webDir": "public",
  "server": {
    "url": "https://your-backend-url.com",
    "cleartext": true
  }
}
```

### Build APK:

```bash
# Sync files
npx cap sync

# Open in Android Studio
npx cap open android

# In Android Studio:
# Build > Build Bundle(s) / APK(s) > Build APK(s)
```

---

## 📱 OPTION 3: Simple WebView (Quick & Dirty)

### For testing only (requires Android Studio):

1. **Install Android Studio**: https://developer.android.com/studio

2. **Create New Project**:
   - Select "Empty Activity"
   - Name: "Mount Made"
   - Package: "com.MountMade.app"

3. **Replace MainActivity content** with:

```java
import android.webkit.WebView;
import android.webkit.WebSettings;

public class MainActivity extends AppCompatActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        WebView webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.loadUrl("https://your-backend-url.com");
        
        setContentView(webView);
    }
}
```

4. **Build APK**:
   - Build > Build Bundle(s) / APK(s) > Build APK(s)

---

## 🌐 Hosting Your Backend (Required)

### Free/Cheap Options:

1. **Railway.app** (Easiest):
   ```bash
   # Install Railway CLI
   npm i -g @railway/cli
   
   # Login and deploy
   railway login
   railway init
   railway up
   ```

2. **Render.com** (Free tier):
   - Connect your GitHub repo
   - Auto-deploys on push

3. **Heroku**:
   ```bash
   heroku create MountMade-app
   git push heroku main
   ```

4. **For Testing - ngrok**:
   ```bash
   npx ngrok http 3000
   # Use the https URL in your app
   ```

---

## 📝 Important Notes:

- **PWABuilder = EASIEST** (30 mins, no coding)
- **Capacitor = MOST PROFESSIONAL** (1-2 hours, full native features)
- **WebView = TESTING ONLY** (quick but limited)

- Your backend MUST be online (not localhost:3000)
- Icons must be 192x192 and 512x512 PNG
- Update all API calls from localhost to your hosted URL

---

## 🔑 Next Steps:

1. ✅ PWA files are already added to your project
2. Create icon images (192x192 and 512x512)
3. Host your backend online
4. Choose a method above
5. Generate APK

Need help with any step? Let me know!
