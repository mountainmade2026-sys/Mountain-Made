// Main JavaScript Utilities

const APK_API_ORIGIN = 'https://mountain-made.onrender.com';
const IS_NATIVE_CAPACITOR = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
const API_BASE = (window.location.protocol === 'file:' || IS_NATIVE_CAPACITOR)
  ? `${APK_API_ORIGIN}/api`
  : '/api';

// Adaptive refresh tuning (auto-optimizes for low/high-end devices)
const performanceTuning = {
  STORAGE_KEY: 'refresh_rate_mode', // auto | low | high

  getMode() {
    const mode = (localStorage.getItem(performanceTuning.STORAGE_KEY) || 'auto').toLowerCase();
    return ['auto', 'low', 'high'].includes(mode) ? mode : 'auto';
  },

  setMode(mode) {
    const normalized = String(mode || '').toLowerCase();
    if (['auto', 'low', 'high'].includes(normalized)) {
      localStorage.setItem(performanceTuning.STORAGE_KEY, normalized);
    }
  },

  detectTier() {
    const mode = performanceTuning.getMode();
    if (mode === 'low' || mode === 'high') return mode;

    const hardwareConcurrency = Number(navigator.hardwareConcurrency || 4);
    const deviceMemory = Number(navigator.deviceMemory || 4);
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const effectiveType = String(connection?.effectiveType || '').toLowerCase();
    const saveData = !!connection?.saveData;

    const lowNetwork = /2g|3g/.test(effectiveType);
    const isLowEnd = saveData || lowNetwork || hardwareConcurrency <= 4 || deviceMemory <= 4;
    const isHighEnd = !saveData && (effectiveType === '' || effectiveType === '4g') && hardwareConcurrency >= 8 && deviceMemory >= 8;

    if (isLowEnd) return 'low';
    if (isHighEnd) return 'high';
    return 'mid';
  },

  getAdaptiveInterval(baseMs, options = {}) {
    const {
      lowMultiplier = 1.8,
      highMultiplier = 0.8,
      min = 1000,
      max = 60000
    } = options;

    const tier = performanceTuning.detectTier();
    let interval = Number(baseMs) || 1000;

    if (tier === 'low') {
      interval = Math.round(interval * lowMultiplier);
    } else if (tier === 'high') {
      interval = Math.round(interval * highMultiplier);
    }

    return Math.max(min, Math.min(max, interval));
  }
};

window.performanceTuning = performanceTuning;

// API Helper Functions
const api = {
  async request(endpoint, options = {}) {
    try {
      const token = localStorage.getItem('token');

      const fetchOptions = { ...(options || {}) };
      const timeoutMs = fetchOptions.timeoutMs;
      delete fetchOptions.timeoutMs;

      const headers = {
        ...(fetchOptions.headers || {})
      };

      // Only set JSON content-type when sending a JSON body.
      // Setting it for GET requests can cause unnecessary preflights in some hosted/network setups.
      const hasBody = fetchOptions.body !== undefined && fetchOptions.body !== null;
      const hasExplicitContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
      const isFormDataBody = (typeof FormData !== 'undefined') && (fetchOptions.body instanceof FormData);
      if (hasBody && !hasExplicitContentType && !isFormDataBody) {
        headers['Content-Type'] = 'application/json';
      }

      if (token && !headers.Authorization) {
        headers.Authorization = `Bearer ${token}`;
      }

      let timeoutId = null;
      let abortController = null;
      if (
        timeoutMs != null &&
        Number.isFinite(Number(timeoutMs)) &&
        Number(timeoutMs) > 0 &&
        !fetchOptions.signal &&
        typeof AbortController !== 'undefined'
      ) {
        abortController = new AbortController();
        fetchOptions.signal = abortController.signal;
        timeoutId = setTimeout(() => {
          try {
            abortController.abort();
          } catch (_) {
            // ignore
          }
        }, Number(timeoutMs));
      }

      let response;
      try {
        response = await fetch(`${API_BASE}${endpoint}`, {
          ...fetchOptions,
          headers,
          credentials: 'include'
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      // Try to parse JSON, but handle empty/non-JSON responses gracefully
      let data = null;
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          console.error('Failed to parse JSON response:', e, text);
          if (!response.ok) {
            throw new Error('Request failed');
          }
          return null;
        }
      }

      if (!response.ok) {
        const msg = (data && data.error) || 'Request failed';
        const detail = data && data.detail;
        throw new Error(detail ? `${msg} (${detail})` : msg);
      }

      return data;
    } catch (error) {
      const isAbort = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || error)));
      if (isAbort) {
        // Fetch was intentionally aborted (usually due to a timeout).
        throw new Error('Request timed out');
      }

      console.error('API Error:', error);
      throw error;
    }
  },

  get(endpoint) {
    return this.request(endpoint);
  },

  post(endpoint, body) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  },

  put(endpoint, body) {
    return this.request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  },

  delete(endpoint) {
    return this.request(endpoint, { method: 'DELETE' });
  },

  // Upload image file (JPG/PNG/GIF)
  async uploadImage(file) {
    try {
      // Validate file type on client side
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
      
      if (!allowedTypes.includes(file.type) || !allowedExtensions.includes(fileExtension)) {
        throw new Error('Invalid file type. Only JPG, PNG, GIF, and WEBP images are allowed.');
      }

      // Check file size (5MB max)
      if (file.size > 5 * 1024 * 1024) {
        throw new Error('File size too large. Maximum size is 5MB.');
      }

      const formData = new FormData();
      formData.append('image', file);

      const token = localStorage.getItem('token');
      const parseResponse = async (response) => {
        const text = await response.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (_) {
            data = { error: text };
          }
        }
        return data;
      };

      const tryUpload = async (url, includeAuthHeader = false) => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: includeAuthHeader && token ? { 'Authorization': `Bearer ${token}` } : {},
          body: formData,
          credentials: 'include'
        });
        const parsed = await parseResponse(resp);
        if (!resp.ok) {
          throw new Error((parsed && parsed.error) || 'Upload failed');
        }
        if (!parsed || !parsed.imageUrl) {
          throw new Error('Upload failed: missing image URL');
        }
        return parsed;
      };

      try {
        return await tryUpload(`${API_BASE}/upload/image`, true);
      } catch (primaryError) {
        const isNetworkLike =
          primaryError instanceof TypeError ||
          /Failed to fetch|ERR_CONNECTION_RESET|NetworkError/i.test(String(primaryError.message || primaryError));

        if (!isNetworkLike) {
          throw primaryError;
        }

        return await tryUpload(`${API_BASE}/upload`, false);
      }
    } catch (error) {
      console.error('Upload Error:', error);
      throw error;
    }
  }
};

// Theme Management
const theme = {
  STORAGE_KEY: 'theme',
  THEME_ATTR: 'data-theme',
  
  init() {
    // Load saved theme or default to light
    const savedTheme = this.get();
    this.apply(savedTheme);
    
    // Set up toggle button listeners
    this.setupToggleButtons();
  },
  
  get() {
    return localStorage.getItem(this.STORAGE_KEY) || 'light';
  },
  
  set(themeName) {
    localStorage.setItem(this.STORAGE_KEY, themeName);
  },
  
  apply(themeName) {
    document.documentElement.setAttribute(this.THEME_ATTR, themeName);
    this.set(themeName);
    this.updateToggleButtons(themeName);
  },
  
  toggle() {
    const current = this.get();
    const next = current === 'light' ? 'dark' : 'light';
    this.apply(next);
  },
  
  setupToggleButtons() {
    // Find all theme toggle buttons and attach listeners
    document.addEventListener('click', (e) => {
      if (e.target.id === 'theme-toggle' || e.target.closest('#theme-toggle')) {
        e.preventDefault();
        this.toggle();
      }
    });
  },
  
  updateToggleButtons(themeName) {
    const toggleButtons = document.querySelectorAll('#theme-toggle');
    const text = themeName === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    toggleButtons.forEach(btn => {
      const iconSpan = btn.querySelector('.accd-icon');
      if (iconSpan) {
        // New design: update icon and preserve the icon span
        const iconEl = iconSpan.querySelector('i');
        if (iconEl) {
          iconEl.className = themeName === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        }
        // Update text node (the text after the span)
        let textNode = null;
        btn.childNodes.forEach(n => { if (n.nodeType === 3 && n.textContent.trim()) textNode = n; });
        if (textNode) textNode.textContent = text;
        else btn.appendChild(document.createTextNode(text));
      } else {
        btn.textContent = text;
      }
    });

    // Sync mobile profile sheet theme toggle
    const psThemeIcon  = document.getElementById('mm-ps-theme-icon');
    const psThemeLabel = document.getElementById('mm-ps-theme-label');
    if (psThemeIcon)  psThemeIcon.className  = themeName === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    if (psThemeLabel) psThemeLabel.textContent = text;
  }
};

// Authentication
const auth = {
  currentUser: null,
  _deliveryAddressCache: null,
  _deliveryAddressCacheAt: 0,

  async checkAuth() {
    try {
      const data = await api.get('/auth/check');
      this.currentUser = data.authenticated ? data.user : null;
      if (!data.authenticated) {
        localStorage.removeItem('token');
      }
      this.updateUI();
      // Apply profile photo from user data
      if (this.currentUser && this.currentUser.profile_photo) {
        applyProfilePhoto(this.currentUser.profile_photo);
      }
      return this.currentUser;
    } catch (error) {
      this.currentUser = null;
      localStorage.removeItem('token');
      this.updateUI();
      return null;
    }
  },

  async login(email, password) {
    const data = await api.post('/auth/login', { email, password });
    const isAdminLike = data?.user?.role === 'admin' || data?.user?.role === 'super_admin';
    if (data?.token && !isAdminLike) {
      localStorage.setItem('token', data.token);
    } else {
      localStorage.removeItem('token');
    }
    this.currentUser = data.user;
    this.updateUI();
    return data;
  },

  async register(userData) {
    const data = await api.post('/auth/register', userData);
    const isAdminLike = data?.user?.role === 'admin' || data?.user?.role === 'super_admin';
    if (data?.token && !isAdminLike) {
      localStorage.setItem('token', data.token);
    } else {
      localStorage.removeItem('token');
    }
    this.currentUser = data.user;
    this.updateUI();
    return data;
  },

  async logout() {
    await api.post('/auth/logout');
    localStorage.removeItem('token');
    this.currentUser = null;
    this.updateUI();
    window.location.href = '/';
  },

  isAuthenticated() {
    return !!this.currentUser;
  },

  isAdmin() {
    return this.currentUser?.role === 'admin' || this.currentUser?.role === 'super_admin';
  },

  isWholesale() {
    return this.currentUser?.role === 'wholesale' && this.currentUser?.is_approved;
  },

  getHomeUrl() {
    if (this.isAdmin()) return '/admin';
    if (this.isWholesale()) return '/wholesale';
    return '/';
  },

  updateUI() {
    const authButtons = document.getElementById('auth-buttons');
    const userMenu = document.getElementById('user-menu');
    const adminLink = document.getElementById('admin-link');

    document.body.classList.add('auth-ready');

    // Always update mobile bottom nav visibility regardless of page layout
    if (typeof window.mmBnavSetAuth === 'function') {
      window.mmBnavSetAuth(this.isAuthenticated());
    }

    if (!authButtons || !userMenu) return;

    if (this.isAuthenticated()) {
      authButtons.classList.add('hidden');
      userMenu.classList.remove('hidden');

      if (adminLink) {
        adminLink.classList.toggle('hidden', !this.isAdmin());
      }
    } else {
      authButtons.classList.remove('hidden');
      userMenu.classList.add('hidden');
      
      if (adminLink) {
        adminLink.classList.add('hidden');
      }
    }

    this.updateAccountDropdownIdentity();

    // Update all navigation links dynamically
    this.updateNavigationLinks();

    // Update delivery address summary under logo
    this.updateDeliveryAddressUI();

    // (mmBnavSetAuth is called at the top of updateUI, before the early-return guard)
  },

  async fetchPrimaryDeliveryAddress(force = false) {
    if (!this.isAuthenticated() || this.isAdmin()) {
      this._deliveryAddressCache = null;
      this._deliveryAddressCacheAt = Date.now();
      return null;
    }

    const cacheTtlMs = 45 * 1000;
    if (!force && this._deliveryAddressCacheAt && (Date.now() - this._deliveryAddressCacheAt) < cacheTtlMs) {
      return this._deliveryAddressCache;
    }

    try {
      const data = await api.get('/addresses');
      const addresses = Array.isArray(data?.addresses) ? data.addresses : [];
      const primary = addresses.find(addr => addr?.is_default) || addresses[0] || null;
      this._deliveryAddressCache = primary;
      this._deliveryAddressCacheAt = Date.now();
      return primary;
    } catch (_) {
      this._deliveryAddressCache = null;
      this._deliveryAddressCacheAt = Date.now();
      return null;
    }
  },

  async updateDeliveryAddressUI(force = false) {
    const shouldShowOnThisPage = () => {
      const rawPath = String(window.location.pathname || '/');
      const path = rawPath.endsWith('/') && rawPath.length > 1 ? rawPath.slice(0, -1) : rawPath;

      const isHome = path === '' || path === '/' || path === '/index.html';
      const isWholesaleDashboard = path === '/wholesale' || path === '/wholesale.html';

      if (this.isWholesale()) return isWholesaleDashboard;
      return isHome;
    };

    const ensureGlobalDeliverBar = () => {
      const navbar = document.querySelector('.navbar');
      if (!navbar) return null;

      let bar = document.getElementById('global-deliver-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'global-deliver-bar';
        bar.className = 'deliver-bar hidden';
        bar.innerHTML = `
          <div class="deliver-bar-container">
            <a class="deliver-bar-link" href="/addresses" title="Manage delivery addresses" aria-label="Manage delivery addresses" aria-live="polite">
              <span class="deliver-bar-icon"><i class="fas fa-location-dot" aria-hidden="true"></i></span>
              <span class="deliver-bar-text">
                <span class="deliver-bar-label"></span>
                <span class="deliver-bar-value"></span>
              </span>
            </a>
          </div>
        `;
        navbar.insertAdjacentElement('afterend', bar);
      }

      const link = bar.querySelector('.deliver-bar-link');
      const label = bar.querySelector('.deliver-bar-label');
      const value = bar.querySelector('.deliver-bar-value');
      return { bar, link, label, value };
    };

    const deliverBar = ensureGlobalDeliverBar();

    const heroDeliveryCard = document.getElementById('wholesale-deliver-card');
    const heroDeliveryLabel = document.getElementById('wholesale-deliver-label');
    const heroDeliveryValue = document.getElementById('wholesale-deliver-value');

    if (!this.isAuthenticated() || this.isAdmin() || !shouldShowOnThisPage()) {
      if (deliverBar?.bar) {
        deliverBar.bar.classList.add('hidden');
      }

      if (heroDeliveryCard) {
        heroDeliveryCard.classList.add('hidden');
      }
      return;
    }

    const address = await this.fetchPrimaryDeliveryAddress(force);
    const fullName = String(address?.full_name || this.currentUser?.full_name || '').trim();
    const shortName = fullName ? fullName.split(' ')[0] : 'Customer';
    const city = String(address?.city || '').trim();
    const state = String(address?.state || '').trim();
    const line1 = String(address?.address_line1 || '').trim();

    const primaryArea = [city, state].filter(Boolean).join(', ');
    const locationText = [primaryArea, line1].filter(Boolean).join(', ') || 'Add delivery address';

    if (deliverBar?.bar && deliverBar.label && deliverBar.value) {
      deliverBar.label.textContent = `Deliver to ${shortName}`;
      deliverBar.value.textContent = locationText;
      deliverBar.bar.classList.remove('hidden');
    }

    if (heroDeliveryCard) {
      if (heroDeliveryLabel) {
        heroDeliveryLabel.textContent = `Deliver to ${shortName}`;
      }
      if (heroDeliveryValue) {
        heroDeliveryValue.textContent = locationText;
      }
      heroDeliveryCard.classList.remove('hidden');
    }
  },

  updateAccountDropdownIdentity() {
    const dropdowns = document.querySelectorAll('#account-dropdown');
    dropdowns.forEach((dropdown) => {
      const nameEl   = dropdown.querySelector('#account-display-name');
      const roleEl   = dropdown.querySelector('#account-display-role');
      const avatarEl = dropdown.querySelector('#account-avatar');

      if (!this.isAuthenticated()) return;

      const name = String(this.currentUser?.full_name || this.currentUser?.email || 'User').trim();

      if (nameEl)   nameEl.textContent   = name;
      if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();

      if (roleEl) {
        if (this.isAdmin())      roleEl.textContent = 'Admin';
        else if (this.isWholesale()) roleEl.textContent = 'Wholesale';
        else                         roleEl.textContent = 'Customer';
      }
    });

    // Also sync the mobile bottom nav profile tab + sheet
    if (this.isAuthenticated() && typeof window.mmBnavUpdateProfile === 'function') {
      window.mmBnavUpdateProfile(this.currentUser);
    }
  },

  updateNavigationLinks() {
    const homeUrl = this.getHomeUrl();

    // Update navbar brand (logo)
    const navbarBrand = document.querySelector('.navbar-brand');
    if (navbarBrand) {
      navbarBrand.setAttribute('href', homeUrl);
    }

    // Update "Home" / "Dashboard" menu links
    const homeLinks = document.querySelectorAll('.navbar-menu a[href="/"], .navbar-menu a[href="/wholesale"]');
    homeLinks.forEach(link => {
      link.setAttribute('href', homeUrl);
      const currentText = link.textContent.trim();
      
      // Update text based on role and current page
      if (currentText !== 'Dashboard') {
        if (this.isWholesale() || this.isAdmin()) {
          link.textContent = 'Dashboard';
        } else {
          link.textContent = 'Home';
        }
      }
    });

    // Update catalog/products link for wholesale users on shared pages
    const productLinks = document.querySelectorAll('.navbar-menu a[href="/products"], .navbar-menu a[href="/wholesale#catalog"], .navbar-menu a[href="/wholesale/#catalog"]');
    productLinks.forEach(link => {
      if (this.isWholesale()) {
        link.setAttribute('href', '/wholesale#catalog');
        link.textContent = 'Catalog';
      } else {
        link.setAttribute('href', '/products');
        if (link.textContent.trim() === 'Catalog') {
          link.textContent = 'Products';
        }
      }
    });

    // Update orders link for wholesale users
    const ordersLinks = document.querySelectorAll('a[href="/orders"]');
    ordersLinks.forEach(link => {
      if (this.isWholesale()) {
        link.setAttribute('href', '/wholesale#orders');
      } else {
        link.setAttribute('href', '/orders');
      }
    });

    // Update back button if it exists
    const backBtn = document.getElementById('back-btn');
    if (backBtn && !backBtn.hasAttribute('data-custom-back')) {
      backBtn.setAttribute('href', homeUrl);
    }
  }
};

// Cart Management
const cart = {
  items: [],
  total: 0,
  itemCount: 0,

  async fetch() {
    if (!auth.isAuthenticated()) {
      this.items = [];
      this.total = 0;
      this.itemCount = 0;
      this.updateBadge();
      return;
    }

    try {
      const data = await api.get('/cart');
      this.items = data.cartItems || [];
      this.total = parseFloat(data.total || 0);
      this.itemCount = this.items.length;
      this.updateBadge();
      return data;
    } catch (error) {
      console.error('Failed to fetch cart:', error);
      return null;
    }
  },

  async add(productId, quantity = 1) {
    try {
      console.log('Cart add called, auth status:', auth.isAuthenticated(), 'currentUser:', auth.currentUser);
      
      // Make sure we have latest auth status
      if (!auth.currentUser) {
        console.log('No currentUser, checking auth...');
        await auth.checkAuth();
        console.log('After checkAuth, authenticated:', auth.isAuthenticated());
      }
      
      if (!auth.isAuthenticated()) {
        showAlert('⚠️  Please login to add items to cart. Click the Login button in the top right.', 'error');
        return false;
      }

      if (auth.isAdmin()) {
        showAlert('Admin accounts are for management only and cannot add products to cart.', 'error');
        return false;
      }

      // Check if user has both email and phone verified
      if (!auth.currentUser.phone) {
        showAlert('Please verify your phone number before shopping. You will be prompted at checkout.', 'warning');
      } else if (!auth.currentUser.email) {
        showAlert('Please verify your email before shopping. You will be prompted at checkout.', 'warning');
      }

      console.log('Adding product to cart:', productId);
      const response = await api.post('/cart/add', { product_id: productId, quantity });
      console.log('Cart add response:', response);
      
      if (response && response.success !== false) {
        await this.fetch();
        // Only show alert if not in direct buy flow
        if (!sessionStorage.getItem('directBuy')) {
          showAlert('Product added to cart!', 'success', { action: { label: 'Go to Cart', href: '/cart' } });
        }
        return true;
      } else {
        throw new Error(response.error || 'Failed to add to cart');
      }
    } catch (error) {
      console.error('Cart add error:', error);
      if (!error.message.includes('Please login')) {
        showAlert('❌ ' + (error.message || 'Failed to add to cart'), 'error');
      }
      return false;
    }
  },

  async update(itemId, quantity) {
    try {
      await api.put(`/cart/${itemId}`, { quantity });
      await this.fetch();
    } catch (error) {
      showAlert(error.message || 'Failed to update cart', 'error');
    }
  },

  async remove(itemId) {
    try {
      await api.delete(`/cart/${itemId}`);
      await this.fetch();
      showAlert('Item removed from cart', 'success');
    } catch (error) {
      showAlert(error.message || 'Failed to remove item', 'error');
    }
  },

  async clear() {
    try {
      await api.delete('/cart');
      await this.fetch();
    } catch (error) {
      showAlert(error.message || 'Failed to clear cart', 'error');
    }
  },

  updateBadge() {
    const badge = document.getElementById('cart-badge');
    if (badge) {
      badge.textContent = this.itemCount;
      badge.classList.toggle('hidden', this.itemCount === 0);
    }
  }
};

// Image Upload Helper
async function uploadProductImage(fileOrInput) {
  try {
    const file = fileOrInput instanceof File
      ? fileOrInput
      : fileOrInput?.files?.[0];
    if (!file) {
      throw new Error('No file selected');
    }
    
    showAlert('Uploading image...', 'info');
    const result = await api.uploadImage(file);
    
    if (result.success) {
      showAlert('Image uploaded successfully!', 'success');
      return result.imageUrl;
    } else {
      throw new Error(result.error || 'Upload failed');
    }
  } catch (error) {
    showAlert(error.message || 'Failed to upload image', 'error');
    return null;
  }
}

// Alert/Notification System
(function () {
  const STYLE_ID = 'mm-toast-styles';
  function ensureToastStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #mm-toast-container {
        position: fixed;
        top: 1.1rem;
        right: 1.1rem;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        pointer-events: none;
        max-width: 340px;
        width: calc(100vw - 2.2rem);
      }
      .mm-toast {
        display: flex;
        align-items: flex-start;
        gap: 0.7rem;
        background: #fff;
        border-radius: 12px;
        padding: 0.78rem 0.9rem;
        box-shadow: 0 8px 28px rgba(0,0,0,0.13), 0 1.5px 4px rgba(0,0,0,0.07);
        pointer-events: all;
        border: 1px solid #e5e7eb;
        transform: translateX(120%);
        opacity: 0;
        transition: transform 0.3s cubic-bezier(0.34,1.25,0.64,1), opacity 0.25s ease;
        overflow: hidden;
        position: relative;
        cursor: pointer;
      }
      .mm-toast.mm-toast-in {
        transform: translateX(0);
        opacity: 1;
      }
      .mm-toast.mm-toast-out {
        transform: translateX(110%);
        opacity: 0;
      }
      .mm-toast-icon {
        width: 30px;
        height: 30px;
        min-width: 30px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.82rem;
        margin-top: 1px;
        flex-shrink: 0;
      }
      .mm-toast-body { flex: 1; min-width: 0; }
      .mm-toast-title {
        font-size: 0.82rem;
        font-weight: 700;
        margin: 0 0 1px;
        line-height: 1.3;
        color: #111827;
      }
      .mm-toast-msg {
        font-size: 0.82rem;
        color: #4b5563;
        margin: 0;
        line-height: 1.4;
        word-break: break-word;
      }
      .mm-toast-close {
        background: none;
        border: none;
        cursor: pointer;
        color: #9ca3af;
        font-size: 0.9rem;
        padding: 0;
        line-height: 1;
        flex-shrink: 0;
        margin-top: 1px;
        transition: color 0.15s;
      }
      .mm-toast-close:hover { color: #374151; }
      .mm-toast-bar {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 3px;
        border-radius: 0 0 12px 12px;
        width: 100%;
        transform-origin: left;
        animation: mm-bar linear forwards;
      }
      @keyframes mm-bar { from { transform: scaleX(1); } to { transform: scaleX(0); } }
      /* success */
      .mm-toast-success .mm-toast-icon { background: #dcfce7; color: #16a34a; }
      .mm-toast-success .mm-toast-title { color: #166534; }
      .mm-toast-success .mm-toast-bar { background: #22c55e; }
      /* error */
      .mm-toast-error .mm-toast-icon { background: #fee2e2; color: #dc2626; }
      .mm-toast-error .mm-toast-title { color: #991b1b; }
      .mm-toast-error .mm-toast-bar { background: #ef4444; }
      /* warning */
      .mm-toast-warning .mm-toast-icon { background: #fef3c7; color: #d97706; }
      .mm-toast-warning .mm-toast-title { color: #92400e; }
      .mm-toast-warning .mm-toast-bar { background: #f59e0b; }
      /* info */
      .mm-toast-info .mm-toast-icon { background: #dbeafe; color: #2563eb; }
      .mm-toast-info .mm-toast-title { color: #1e40af; }
      .mm-toast-info .mm-toast-bar { background: #3b82f6; }
      @media (prefers-color-scheme: dark) {
        html[data-theme="dark"] .mm-toast {
          background: #1e2431;
          border-color: #2d3748;
          box-shadow: 0 8px 28px rgba(0,0,0,0.45);
        }
        html[data-theme="dark"] .mm-toast-title { color: #f3f4f6; }
        html[data-theme="dark"] .mm-toast-msg { color: #9ca3af; }
      }
      html[data-theme="dark"] .mm-toast {
        background: #1e2431;
        border-color: #2d3748;
        box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      }
      html[data-theme="dark"] .mm-toast-title { color: #f3f4f6; }
      html[data-theme="dark"] .mm-toast-msg { color: #9ca3af; }
      html[data-theme="dark"] .mm-toast-close { color: #6b7280; }
      html[data-theme="dark"] .mm-toast-close:hover { color: #d1d5db; }
      .mm-toast-action {
        display: inline-block;
        margin-top: 0.45rem;
        padding: 0.26rem 0.72rem;
        background: #16a34a;
        color: #fff !important;
        border-radius: 6px;
        font-size: 0.75rem;
        font-weight: 600;
        text-decoration: none;
        transition: background 0.15s;
        pointer-events: all;
      }
      .mm-toast-action:hover { background: #15803d; color: #fff !important; }
      html[data-theme="dark"] .mm-toast-action { background: #16a34a; }
      html[data-theme="dark"] .mm-toast-action:hover { background: #15803d; }
    `;
    document.head.appendChild(s);
  }

  function getContainer() {
    let c = document.getElementById('mm-toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'mm-toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  const TYPES = {
    success: { icon: 'fas fa-check',         label: 'Success' },
    error:   { icon: 'fas fa-times',          label: 'Error'   },
    warning: { icon: 'fas fa-exclamation',    label: 'Warning' },
    info:    { icon: 'fas fa-info',           label: 'Info'    },
  };

  window.showAlert = function showAlert(message, type = 'info', options = {}) {
    ensureToastStyles();
    const duration = type === 'error' ? 4500 : 3200;
    const cfg = TYPES[type] || TYPES.info;
    const actionHtml = options.action
      ? `<a class="mm-toast-action" href="${options.action.href}" onclick="event.stopPropagation()">${options.action.label}</a>`
      : '';

    const toast = document.createElement('div');
    toast.className = `mm-toast mm-toast-${type}`;
    toast.innerHTML = `
      <div class="mm-toast-icon"><i class="${cfg.icon}"></i></div>
      <div class="mm-toast-body">
        <p class="mm-toast-title">${cfg.label}</p>
        <p class="mm-toast-msg">${message.replace(/^[✓❌⚠️ℹ️]+\s*/u, '')}</p>
        ${actionHtml}
      </div>
      <button class="mm-toast-close" aria-label="Dismiss"><i class="fas fa-times"></i></button>
      <span class="mm-toast-bar" style="animation-duration:${duration}ms"></span>
    `;

    const close = () => {
      toast.classList.add('mm-toast-out');
      setTimeout(() => toast.remove(), 320);
    };
    toast.querySelector('.mm-toast-close').addEventListener('click', close);
    toast.addEventListener('click', (e) => {
      if (e.target.closest('.mm-toast-action')) return;
      close();
    });

    getContainer().appendChild(toast);
    // Trigger slide-in on next frame
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('mm-toast-in')));

    setTimeout(close, duration);
  };
})();

function createAlertContainer() { /* legacy — replaced by mm-toast-container */ return document.createElement('div'); }

// ─── Mobile Bottom Navigation Bar ────────────────────────────────────────────
(function () {
  const EXCLUDED_PAGES = ['/login', '/register', '/admin', '/admin_backup', '/wholesale'];

  function shouldShowBottomNav() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    return !EXCLUDED_PAGES.some(p => path === p || path.startsWith(p + '/'));
  }

  function getActivePage() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/') return 'home';
    if (path.startsWith('/products')) return 'products';
    if (path.startsWith('/orders')) return 'orders';
    if (path.startsWith('/cart')) return 'cart';
    return 'menu';
  }

  function openMobileMenu() {
    const menu = document.querySelector('.navbar-menu');
    const toggle = document.querySelector('.mobile-menu-toggle');
    if (menu) {
      menu.classList.toggle('mobile-active');
      if (toggle) {
        const icon = toggle.querySelector('i');
        if (icon) {
          icon.className = menu.classList.contains('mobile-active')
            ? 'fas fa-times'
            : 'fas fa-bars';
        }
      }
      // Close when clicking outside
      if (menu.classList.contains('mobile-active')) {
        const close = (e) => {
          if (!menu.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
            menu.classList.remove('mobile-active');
            if (toggle) { const ic = toggle.querySelector('i'); if (ic) ic.className = 'fas fa-bars'; }
            document.removeEventListener('click', close);
          }
        };
        setTimeout(() => document.addEventListener('click', close), 50);
      }
    }
  }

  function syncCartBadge(nav) {
    const badge = nav.querySelector('#mm-bnav-cart-badge');
    if (!badge) return;
    const existing = document.getElementById('cart-badge');
    const count = existing ? (existing.textContent || '').trim() : '0';
    const num = parseInt(count, 10) || 0;
    badge.textContent = num > 99 ? '99+' : String(num);
    badge.classList.toggle('hidden', num <= 0);
  }

  function init() {
    if (!shouldShowBottomNav()) return;
    if (document.getElementById('mm-bottom-nav')) return;

    const active = getActivePage();

    const nav = document.createElement('nav');
    nav.id = 'mm-bottom-nav';
    nav.className = 'mm-bottom-nav';
    nav.setAttribute('aria-label', 'Bottom navigation');
    nav.innerHTML = `
      <a href="/" class="mm-bnav-item ${active === 'home' ? 'mm-bnav-active' : ''}" aria-label="Home">
        <span class="mm-bnav-ripple"></span>
        <span class="mm-bnav-icon-wrap"><i class="fas fa-home"></i></span>
        <span class="mm-bnav-label">Home</span>
      </a>
      <a href="/products" class="mm-bnav-item ${active === 'products' ? 'mm-bnav-active' : ''}" aria-label="Products">
        <span class="mm-bnav-ripple"></span>
        <span class="mm-bnav-icon-wrap">
          <i class="fas fa-store"></i>
        </span>
        <span class="mm-bnav-label">Shop</span>
      </a>
      <a href="/cart" class="mm-bnav-item ${active === 'cart' ? 'mm-bnav-active' : ''}" aria-label="Cart">
        <span class="mm-bnav-ripple"></span>
        <span class="mm-bnav-icon-wrap">
          <i class="fas fa-shopping-basket"></i>
          <span id="mm-bnav-cart-badge" class="mm-bnav-badge hidden">0</span>
        </span>
        <span class="mm-bnav-label">Cart</span>
      </a>
      <a href="/orders" class="mm-bnav-item ${active === 'orders' ? 'mm-bnav-active' : ''}" aria-label="Orders">
        <span class="mm-bnav-ripple"></span>
        <span class="mm-bnav-icon-wrap"><i class="fas fa-box-open"></i></span>
        <span class="mm-bnav-label">Orders</span>
      </a>
      <button type="button" class="mm-bnav-item" aria-label="Profile" id="mm-bnav-profile-btn">
        <span class="mm-bnav-ripple"></span>
        <span class="mm-bnav-icon-wrap">
          <span class="mm-bnav-avatar" id="mm-bnav-profile-avatar">U</span>
        </span>
        <span class="mm-bnav-label">Profile</span>
      </button>
    `;

    document.body.appendChild(nav);
    document.body.classList.add('has-bottom-nav');
    // Hide until auth state is confirmed
    nav.style.display = 'none';
    document.body.classList.remove('has-bottom-nav');

    // Profile button → open profile sheet
    const profileBtn = nav.querySelector('#mm-bnav-profile-btn');
    if (profileBtn) profileBtn.addEventListener('click', openProfileSheet);

    // Sync cart badge immediately and whenever it changes
    syncCartBadge(nav);
    const cartBadgeSource = document.getElementById('cart-badge');
    if (cartBadgeSource) {
      new MutationObserver(() => syncCartBadge(nav))
        .observe(cartBadgeSource, { childList: true, characterData: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Profile Sheet ──────────────────────────────────────────────
  function getOrCreateProfileSheet() {
    let overlay = document.getElementById('mm-profile-sheet');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'mm-profile-sheet';
    overlay.className = 'mm-ps-overlay';
    overlay.innerHTML = `
      <div class="mm-ps-panel" id="mm-ps-panel">
        <div class="mm-ps-handle"></div>
        <div class="mm-ps-header">
          <div class="mm-ps-avatar-lg" id="mm-ps-avatar">U</div>
          <div class="mm-ps-info">
            <div class="mm-ps-user-name" id="mm-ps-name">User</div>
            <div class="mm-ps-user-role" id="mm-ps-role">Member</div>
          </div>
        </div>
        <div class="mm-ps-body">
          <div class="mm-ps-group">
            <button class="mm-ps-item" id="mm-ps-edit-profile">
              <span class="mm-ps-item-icon"><i class="fas fa-user-edit"></i></span>
              <span class="mm-ps-item-label">Edit Profile</span>
              <i class="fas fa-chevron-right mm-ps-chevron"></i>
            </button>
            <a href="/orders" class="mm-ps-item">
              <span class="mm-ps-item-icon"><i class="fas fa-box-open"></i></span>
              <span class="mm-ps-item-label">My Orders</span>
              <i class="fas fa-chevron-right mm-ps-chevron"></i>
            </a>
            <a href="/returns" class="mm-ps-item">
              <span class="mm-ps-item-icon"><i class="fas fa-undo-alt"></i></span>
              <span class="mm-ps-item-label">My Returns</span>
              <i class="fas fa-chevron-right mm-ps-chevron"></i>
            </a>
            <a href="/addresses" class="mm-ps-item">
              <span class="mm-ps-item-icon"><i class="fas fa-map-marker-alt"></i></span>
              <span class="mm-ps-item-label">My Addresses</span>
              <i class="fas fa-chevron-right mm-ps-chevron"></i>
            </a>
            <button class="mm-ps-item" id="mm-ps-change-password">
              <span class="mm-ps-item-icon"><i class="fas fa-key"></i></span>
              <span class="mm-ps-item-label">Change Password</span>
              <i class="fas fa-chevron-right mm-ps-chevron"></i>
            </button>
          </div>
          <div class="mm-ps-group">
            <button class="mm-ps-item" id="mm-ps-theme-toggle">
              <span class="mm-ps-item-icon"><i class="fas fa-moon" id="mm-ps-theme-icon"></i></span>
              <span class="mm-ps-item-label" id="mm-ps-theme-label">Switch to Dark Mode</span>
              <i class="fas fa-chevron-right mm-ps-chevron"></i>
            </button>
          </div>
          <div class="mm-ps-group">
            <button class="mm-ps-item mm-ps-item-danger" id="mm-ps-logout">
              <span class="mm-ps-item-icon"><i class="fas fa-sign-out-alt"></i></span>
              <span class="mm-ps-item-label">Logout</span>
              <i class="fas fa-chevron-right mm-ps-chevron"></i>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Close when tapping backdrop (outside panel)
    overlay.addEventListener('click', (e) => {
      if (!e.target.closest('#mm-ps-panel')) closeProfileSheet();
    });

    // Edit Profile
    overlay.querySelector('#mm-ps-edit-profile').addEventListener('click', () => {
      closeProfileSheet();
      setTimeout(() => { if (typeof window.openProfileModal === 'function') window.openProfileModal(); }, 220);
    });

    // Change Password
    overlay.querySelector('#mm-ps-change-password').addEventListener('click', () => {
      closeProfileSheet();
      setTimeout(() => { if (typeof window.openAccountManagementModal === 'function') window.openAccountManagementModal(); }, 220);
    });

    // Theme toggle
    overlay.querySelector('#mm-ps-theme-toggle').addEventListener('click', () => {
      // theme is a const in outer scope — call directly
      if (typeof theme !== 'undefined' && typeof theme.toggle === 'function') {
        theme.toggle();
      }
      // updateToggleButtons already runs inside theme.toggle → theme.apply → theme.updateToggleButtons
      // but update the sheet label/icon as well just in case
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const icon = overlay.querySelector('#mm-ps-theme-icon');
      const label = overlay.querySelector('#mm-ps-theme-label');
      if (icon) icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
      if (label) label.textContent = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    });

    // Logout
    overlay.querySelector('#mm-ps-logout').addEventListener('click', async () => {
      closeProfileSheet();
      if (typeof showConfirmDialog === 'function') {
        const ok = await showConfirmDialog('Are you sure you want to logout?', { title: 'Logout', confirmText: 'Logout' });
        if (ok) await auth.logout();
      } else {
        await auth.logout();
      }
    });

    return overlay;
  }

  function openProfileSheet() {
    const overlay = getOrCreateProfileSheet();

    // Always sync latest user data (sheet may have been created with defaults)
    if (typeof auth !== 'undefined' && auth.currentUser) {
      if (typeof window.mmBnavUpdateProfile === 'function') {
        window.mmBnavUpdateProfile(auth.currentUser);
      }
    }

    // Sync current theme label
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const icon = overlay.querySelector('#mm-ps-theme-icon');
    const label = overlay.querySelector('#mm-ps-theme-label');
    if (icon) icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    if (label) label.textContent = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
    // Mark profile tab active
    const profileBtn = document.getElementById('mm-bnav-profile-btn');
    if (profileBtn) profileBtn.classList.add('mm-bnav-profile-active');
    // Show
    overlay.style.display = '';
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('mm-ps-open')));
    document.body.style.overflow = 'hidden';
  }

  function closeProfileSheet() {
    const overlay = document.getElementById('mm-profile-sheet');
    if (!overlay) return;
    overlay.classList.remove('mm-ps-open');
    const profileBtn = document.getElementById('mm-bnav-profile-btn');
    if (profileBtn) profileBtn.classList.remove('mm-bnav-profile-active');
    document.body.style.overflow = '';
    setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 380);
  }

  // Handle back gesture / escape key to close sheet
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProfileSheet();
  });

  // Public: sync avatar+name+role in profile sheet and bottom-nav tab from auth data
  window.mmBnavUpdateProfile = function (user) {
    if (!user) return;
    const name = String(user.full_name || user.email || 'User').trim();
    const initial = name.charAt(0).toUpperCase();
    let role = 'Customer';
    if (user.role === 'admin' || user.role === 'super_admin') role = 'Admin';
    else if (user.role === 'wholesale' && user.is_approved) role = 'Wholesale';
    const photo = user.profile_photo || '';

    // Bottom nav tab avatar
    const tabAvatar = document.getElementById('mm-bnav-profile-avatar');
    if (tabAvatar) {
      if (photo) {
        tabAvatar.style.backgroundImage = `url(${photo})`;
        tabAvatar.style.backgroundSize = 'cover';
        tabAvatar.style.backgroundPosition = 'center';
        tabAvatar.textContent = '';
      } else {
        tabAvatar.style.backgroundImage = '';
        tabAvatar.textContent = initial;
      }
    }

    // Profile sheet (if already created)
    const sheet = document.getElementById('mm-profile-sheet');
    if (sheet) {
      const avatarEl = sheet.querySelector('#mm-ps-avatar');
      const nameEl   = sheet.querySelector('#mm-ps-name');
      const roleEl   = sheet.querySelector('#mm-ps-role');
      if (avatarEl) {
        if (photo) {
          avatarEl.style.backgroundImage = `url(${photo})`;
          avatarEl.style.backgroundSize = 'cover';
          avatarEl.style.backgroundPosition = 'center';
          avatarEl.textContent = '';
        } else {
          avatarEl.style.backgroundImage = '';
          avatarEl.textContent = initial;
        }
      }
      if (nameEl)   nameEl.textContent   = name;
      if (roleEl)   roleEl.textContent   = role;
    }
  };

  // Called by auth.updateUI() to show/hide based on login state
  window.mmBnavSetAuth = function (isLoggedIn) {
    if (!shouldShowBottomNav()) return;
    // Ensure the nav exists (in case init hasn't run yet)
    if (!document.getElementById('mm-bottom-nav')) init();
    const nav = document.getElementById('mm-bottom-nav');
    if (!nav) return;
    if (isLoggedIn) {
      nav.style.display = '';
      document.body.classList.add('has-bottom-nav');
    } else {
      nav.style.display = 'none';
      document.body.classList.remove('has-bottom-nav');
    }
  };
})();


const APP_DIALOG_STYLE_ID = 'app-dialog-styles';

function ensureAppDialogStyles() {
  if (document.getElementById(APP_DIALOG_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = APP_DIALOG_STYLE_ID;
  style.textContent = `
    .app-dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, 0.55);
      backdrop-filter: blur(3px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2500;
      padding: 1rem;
    }
    .app-dialog {
      width: min(100%, 460px);
      background: var(--bg-primary, #ffffff);
      border: 1px solid var(--border-primary, #e5e7eb);
      border-radius: 14px;
      box-shadow: 0 24px 48px rgba(15, 23, 42, 0.25);
      overflow: hidden;
    }
    .app-dialog-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-primary, #e5e7eb);
      background: var(--bg-secondary, #f8fafc);
    }
    .app-dialog-icon {
      width: 34px;
      height: 34px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      font-size: 1rem;
      flex-shrink: 0;
    }
    .app-dialog-icon.warning { background: #fff7ed; color: #c2410c; }
    .app-dialog-icon.danger { background: #fef2f2; color: #b91c1c; }
    .app-dialog-icon.info { background: #eff6ff; color: #1d4ed8; }
    .app-dialog-title {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--text-primary, #0f172a);
    }
    .app-dialog-body {
      padding: 1rem 1.25rem;
      color: var(--text-secondary, #334155);
      line-height: 1.55;
      font-size: 0.95rem;
    }
    .app-dialog-input {
      width: 100%;
      margin-top: 0.75rem;
      border: 1px solid var(--border-primary, #cbd5e1);
      border-radius: 8px;
      padding: 0.65rem 0.75rem;
      font-size: 0.95rem;
      background: var(--bg-primary, #ffffff);
      color: var(--text-primary, #0f172a);
    }
    .app-dialog-input:focus {
      outline: none;
      border-color: var(--primary-500, #22c55e);
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.15);
    }
    .app-dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      padding: 0 1.25rem 1rem;
    }
    .app-dialog-btn {
      border: 1px solid var(--border-primary, #cbd5e1);
      border-radius: 8px;
      padding: 0.55rem 1rem;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .app-dialog-btn.cancel {
      background: var(--bg-primary, #ffffff);
      color: var(--text-primary, #0f172a);
    }
    .app-dialog-btn.cancel:hover { background: var(--bg-secondary, #f1f5f9); }
    .app-dialog-btn.confirm {
      background: var(--primary-500, #22c55e);
      border-color: var(--primary-500, #22c55e);
      color: #ffffff;
    }
    .app-dialog-btn.confirm:hover { filter: brightness(0.95); }
    .app-dialog-btn.confirm.danger {
      background: #dc2626;
      border-color: #dc2626;
    }
    @media (max-width: 480px) {
      .app-dialog { width: 100%; border-radius: 12px; }
      .app-dialog-header, .app-dialog-body, .app-dialog-actions { padding-left: 1rem; padding-right: 1rem; }
      .app-dialog-actions { flex-direction: column-reverse; }
      .app-dialog-btn { width: 100%; }
    }
  `;

  document.head.appendChild(style);
}

function closeAppDialog(dialogOverlay) {
  if (!dialogOverlay) return;
  dialogOverlay.remove();
  document.body.style.overflow = '';
}

function buildDialogIcon(iconType) {
  if (iconType === 'danger') return '<i class="fas fa-triangle-exclamation"></i>';
  if (iconType === 'warning') return '<i class="fas fa-circle-question"></i>';
  return '<i class="fas fa-circle-info"></i>';
}

function showConfirmDialog(message, options = {}) {
  ensureAppDialogStyles();

  const {
    title = 'Please Confirm',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = false,
    icon = danger ? 'danger' : 'warning'
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    overlay.innerHTML = `
      <div class="app-dialog" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="app-dialog-header">
          <div class="app-dialog-icon ${icon}">${buildDialogIcon(icon)}</div>
          <h3 class="app-dialog-title">${title}</h3>
        </div>
        <div class="app-dialog-body">${message}</div>
        <div class="app-dialog-actions">
          <button type="button" class="app-dialog-btn cancel" data-cancel>${cancelText}</button>
          <button type="button" class="app-dialog-btn confirm ${danger ? 'danger' : ''}" data-confirm>${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');

    const onCancel = () => {
      closeAppDialog(overlay);
      resolve(false);
    };

    const onConfirm = () => {
      closeAppDialog(overlay);
      resolve(true);
    };

    confirmBtn?.addEventListener('click', onConfirm);
    cancelBtn?.addEventListener('click', onCancel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) onCancel();
    });

    const keyHandler = (event) => {
      if (!document.body.contains(overlay)) {
        document.removeEventListener('keydown', keyHandler);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', keyHandler);

    setTimeout(() => cancelBtn?.focus(), 0);
  });
}

function showPromptDialog(message, options = {}) {
  ensureAppDialogStyles();

  const {
    title = 'Please Confirm',
    placeholder = '',
    confirmText = 'Submit',
    cancelText = 'Cancel',
    danger = false,
    icon = danger ? 'danger' : 'warning'
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    overlay.innerHTML = `
      <div class="app-dialog" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="app-dialog-header">
          <div class="app-dialog-icon ${icon}">${buildDialogIcon(icon)}</div>
          <h3 class="app-dialog-title">${title}</h3>
        </div>
        <div class="app-dialog-body">
          <div>${message}</div>
          <input class="app-dialog-input" type="text" data-input placeholder="${placeholder}">
        </div>
        <div class="app-dialog-actions">
          <button type="button" class="app-dialog-btn cancel" data-cancel>${cancelText}</button>
          <button type="button" class="app-dialog-btn confirm ${danger ? 'danger' : ''}" data-confirm>${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const input = overlay.querySelector('[data-input]');
    const confirmBtn = overlay.querySelector('[data-confirm]');
    const cancelBtn = overlay.querySelector('[data-cancel]');

    const onCancel = () => {
      closeAppDialog(overlay);
      resolve(null);
    };

    const onConfirm = () => {
      const value = String(input?.value || '').trim();
      closeAppDialog(overlay);
      resolve(value);
    };

    confirmBtn?.addEventListener('click', onConfirm);
    cancelBtn?.addEventListener('click', onCancel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) onCancel();
    });

    const keyHandler = (event) => {
      if (!document.body.contains(overlay)) {
        document.removeEventListener('keydown', keyHandler);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener('keydown', keyHandler);

    setTimeout(() => input?.focus(), 0);
  });
}

window.showConfirmDialog = showConfirmDialog;
window.showPromptDialog = showPromptDialog;

// Modal System
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
}

// Profile management (name, phone, photo)
const PROFILE_MODAL_ID = 'profile-modal';
const PROFILE_STYLE_ID = 'profile-modal-styles';
const ACCOUNT_MODAL_ID = 'account-management-modal';
function ensureProfileModal() {
  if (document.getElementById(PROFILE_MODAL_ID)) return;

  if (!document.getElementById(PROFILE_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = PROFILE_STYLE_ID;
    style.textContent = `
      .profile-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 2100; padding: 1rem; }
      .profile-modal.hidden { display: none; }
      .profile-modal-dialog { background: var(--bg-primary, #fff); color: var(--text-primary, #111827); border-radius: 12px; max-width: 480px; width: 95%; padding: 1.5rem; box-shadow: 0 20px 40px rgba(0,0,0,0.15); border: 1px solid var(--border-primary, #e5e7eb); }
      .profile-modal-dialog h3 { color: var(--text-primary, #111827); }
      .profile-modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
      .profile-avatar-preview { width: 80px; height: 80px; border-radius: 50%; background: var(--bg-secondary, #f1f5f9); border: 2px dashed var(--border-primary, #cbd5e1); display: grid; place-items: center; color: var(--text-secondary, #64748b); font-weight: 700; overflow: hidden; }
      .profile-avatar-preview.has-photo { border-style: solid; background-size: cover; background-position: center; color: transparent; }
      .profile-avatar-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
      .profile-modal-sub { color: var(--text-secondary, #6b7280); margin-top: 0; margin-bottom: 1rem; }
    `;
    document.head.appendChild(style);
  }

  const modal = document.createElement('div');
  modal.id = PROFILE_MODAL_ID;
  modal.className = 'profile-modal hidden';
  modal.innerHTML = `
    <div class="profile-modal-dialog">
      <h3 style="margin:0 0 0.25rem 0;">Edit Profile</h3>
      <p class="profile-modal-sub">Update your display name, phone number, and profile picture.</p>
      <div class="profile-avatar-row">
        <div id="profile-avatar-preview" class="profile-avatar-preview">+</div>
        <div style="flex:1;">
          <label class="form-label" for="profile-photo-input">Profile picture</label>
          <input type="file" id="profile-photo-input" accept="image/*" class="form-input">
          <div class="form-help" style="margin-top:0.25rem;">Image stays on your account and shows on your account icon.</div>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="profile-name">Full Name</label>
        <input type="text" id="profile-name" class="form-input" placeholder="Your name">
      </div>
      <div class="form-group">
        <label class="form-label" for="profile-phone">Phone Number</label>
        <input type="text" id="profile-phone" class="form-input" placeholder="10-digit phone">
      </div>
      <div class="profile-modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal('${PROFILE_MODAL_ID}')">Cancel</button>
        <button type="button" id="profile-save" class="btn btn-primary">Save Profile</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const fileInput = modal.querySelector('#profile-photo-input');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const result = await api.uploadImage(file);
        if (result?.imageUrl) {
          // Save to user profile in database
          await api.put('/auth/profile', {
            full_name: auth.currentUser?.full_name || '',
            phone: auth.currentUser?.phone || '',
            profile_photo: result.imageUrl
          });
          
          // Update current user object
          if (auth.currentUser) {
            auth.currentUser.profile_photo = result.imageUrl;
          }
          
          // Update UI
          applyProfilePhoto(result.imageUrl);
          renderProfilePreview(result.imageUrl);
          showAlert('Profile picture updated.', 'success');
        }
      } catch (error) {
        showAlert(error.message || 'Failed to upload profile picture', 'error');
      }
    });
  }

  const saveBtn = modal.querySelector('#profile-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveProfileChanges);
  }
}

function ensureAccountManagementModal() {
  if (document.getElementById(ACCOUNT_MODAL_ID)) return;

  const modal = document.createElement('div');
  modal.id = ACCOUNT_MODAL_ID;
  modal.className = 'profile-modal hidden';
  modal.innerHTML = `
    <div class="profile-modal-dialog">
      <h3 style="margin:0 0 0.25rem 0;">Account Management</h3>
      <p class="profile-modal-sub">Change your account password securely.</p>
      <div class="form-group">
        <label class="form-label" for="account-old-password">Old Password</label>
        <input type="password" id="account-old-password" class="form-input" placeholder="Enter old password">
      </div>
      <div class="form-group">
        <label class="form-label" for="account-new-password">New Password</label>
        <input type="password" id="account-new-password" class="form-input" placeholder="Enter new password">
      </div>
      <div class="form-group">
        <label class="form-label" for="account-confirm-password">Confirm Password</label>
        <input type="password" id="account-confirm-password" class="form-input" placeholder="Confirm new password">
      </div>
      <div class="profile-modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal('${ACCOUNT_MODAL_ID}')">Cancel</button>
        <button type="button" id="account-password-save" class="btn btn-primary">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const saveBtn = modal.querySelector('#account-password-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', changeAccountPassword);
  }
}

async function openAccountManagementModal() {
  ensureProfileModal();
  ensureAccountManagementModal();

  const oldInput = document.getElementById('account-old-password');
  const newInput = document.getElementById('account-new-password');
  const confirmInput = document.getElementById('account-confirm-password');

  if (oldInput) oldInput.value = '';
  if (newInput) newInput.value = '';
  if (confirmInput) confirmInput.value = '';

  openModal(ACCOUNT_MODAL_ID);
  setTimeout(() => oldInput?.focus(), 0);
}

async function changeAccountPassword() {
  const oldInput = document.getElementById('account-old-password');
  const newInput = document.getElementById('account-new-password');
  const confirmInput = document.getElementById('account-confirm-password');

  const old_password = String(oldInput?.value || '').trim();
  const new_password = String(newInput?.value || '').trim();
  const confirm_password = String(confirmInput?.value || '').trim();

  if (!old_password || !new_password || !confirm_password) {
    showAlert('Please fill old password, new password, and confirm password.', 'error');
    return;
  }

  if (new_password.length < 6) {
    showAlert('New password must be at least 6 characters.', 'error');
    return;
  }

  if (new_password !== confirm_password) {
    showAlert('New password and confirm password do not match.', 'error');
    return;
  }

  const saveBtn = document.getElementById('account-password-save');
  const previousLabel = saveBtn?.innerHTML;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
  }

  try {
    await api.put('/auth/change-password', { old_password, new_password, confirm_password });
    showAlert('Password updated successfully. Use your new password next login.', 'success');
    closeModal(ACCOUNT_MODAL_ID);
  } catch (error) {
    showAlert(error.message || 'Failed to change password.', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = previousLabel || 'Save';
    }
  }
}

function renderProfilePreview(url) {
  const preview = document.getElementById('profile-avatar-preview');
  if (!preview) return;
  if (url) {
    preview.classList.add('has-photo');
    preview.style.backgroundImage = `url(${url})`;
    preview.textContent = '';
  } else {
    preview.classList.remove('has-photo');
    preview.style.backgroundImage = '';
    preview.textContent = '+';
  }
}

function applyProfilePhoto(url) {
  // ── Desktop top-navbar account-toggle ──
  const toggleButtons = document.querySelectorAll('#account-toggle');
  toggleButtons.forEach((btn) => {
    const icon = btn.querySelector('i');
    if (url) {
      btn.style.backgroundImage = `url(${url})`;
      btn.style.backgroundSize = 'cover';
      btn.style.backgroundPosition = 'center';
      btn.style.borderRadius = '50%';
      btn.classList.add('has-profile-photo');
      if (icon) icon.style.display = 'none';
    } else {
      btn.style.backgroundImage = '';
      btn.classList.remove('has-profile-photo');
      if (icon) icon.style.display = '';
    }
  });

  // ── Mobile bottom-nav profile tab avatar ──
  const tabAvatar = document.getElementById('mm-bnav-profile-avatar');
  if (tabAvatar) {
    if (url) {
      tabAvatar.style.backgroundImage = `url(${url})`;
      tabAvatar.style.backgroundSize = 'cover';
      tabAvatar.style.backgroundPosition = 'center';
      tabAvatar.textContent = '';
    } else {
      tabAvatar.style.backgroundImage = '';
      // Restore initial from auth user if available
      const name = String(auth.currentUser?.full_name || auth.currentUser?.email || 'U').trim();
      tabAvatar.textContent = name.charAt(0).toUpperCase();
    }
  }

  // ── Mobile profile sheet large avatar ──
  const sheetAvatar = document.getElementById('mm-ps-avatar');
  if (sheetAvatar) {
    if (url) {
      sheetAvatar.style.backgroundImage = `url(${url})`;
      sheetAvatar.style.backgroundSize = 'cover';
      sheetAvatar.style.backgroundPosition = 'center';
      sheetAvatar.textContent = '';
    } else {
      sheetAvatar.style.backgroundImage = '';
      const name = String(auth.currentUser?.full_name || auth.currentUser?.email || 'U').trim();
      sheetAvatar.textContent = name.charAt(0).toUpperCase();
    }
  }

  renderProfilePreview(url || '');
}

async function openProfileModal() {
  ensureProfileModal();
  const profile = await api.get('/auth/profile').catch(() => null);
  const user = profile?.user || auth.currentUser || {};

  const nameInput = document.getElementById('profile-name');
  const phoneInput = document.getElementById('profile-phone');

  if (nameInput) nameInput.value = user.full_name || '';
  if (phoneInput) phoneInput.value = user.phone || '';

  applyProfilePhoto(user.profile_photo || '');
  openModal(PROFILE_MODAL_ID);
}

async function saveProfileChanges() {
  const nameInput = document.getElementById('profile-name');
  const phoneInput = document.getElementById('profile-phone');

  const full_name = nameInput?.value?.trim();
  const phone = phoneInput?.value?.trim();

  if (!full_name) {
    showAlert('Full name is required.', 'error');
    if (nameInput) nameInput.focus();
    return;
  }

  if (phone && !validatePhone(phone)) {
    showAlert('Enter a valid 10-digit phone number.', 'error');
    if (phoneInput) phoneInput.focus();
    return;
  }

  try {
    const resp = await api.put('/auth/profile', { full_name, phone });
    if (resp?.user) {
      auth.currentUser = resp.user;
      auth.updateUI();
    }
    showAlert('Profile updated successfully.', 'success');
    closeModal(PROFILE_MODAL_ID);
  } catch (error) {
    showAlert(error.message || 'Failed to update profile.', 'error');
  }
}

// Format Currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR'
  }).format(amount);
}

// Format Date
function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

// Format Date & Time
function formatDateTime(dateString) {
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Loading State
function showLoading(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  }
}

function hideLoading(elementId) {
  const element = document.getElementById(elementId);
  if (element) {
    element.innerHTML = '';
  }
}

function optimizeDynamicImages(root = document) {
  const scope = root && root.querySelectorAll ? root : document;
  const images = scope.querySelectorAll('img:not([data-image-optimized="true"])');

  images.forEach((img) => {
    const isCritical = !!img.closest('.hero, .search-section, .navbar-brand');

    if (!img.getAttribute('decoding')) {
      img.setAttribute('decoding', 'async');
    }

    if (!img.getAttribute('loading')) {
      img.setAttribute('loading', isCritical ? 'eager' : 'lazy');
    }

    if (!img.style.aspectRatio) {
      if (img.classList.contains('card-image') || img.classList.contains('carousel-item-image')) {
        img.style.aspectRatio = '4 / 3';
      } else if (img.classList.contains('category-image')) {
        img.style.aspectRatio = '1 / 1';
      }
    }

    img.setAttribute('data-image-optimized', 'true');
  });
}

// Form Validation
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function validatePhone(phone) {
  const re = /^\d{10}$/;
  return re.test(phone.replace(/\D/g, ''));
}

function validatePassword(password) {
  return password.length >= 6;
}

// File validation helper
function validateImageFile(file) {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
  const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
  

  
  if (!allowedTypes.includes(file.type) || !allowedExtensions.includes(fileExtension)) {
    return { valid: false, error: 'Invalid file type. Only JPG, PNG and GIF images are allowed.' };
  }
  
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: 'File size too large. Maximum size is 5MB.' };
  }
  
  return { valid: true };
}

// Initialize app
async function initApp() {
  // Initialize theme before anything else
  theme.init();
  
  await auth.checkAuth();
  await auth.updateDeliveryAddressUI(true);
  await cart.fetch();
  optimizeDynamicImages(document);
  
  // Setup logout button
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      auth.logout();
    });
  }

  // Setup mobile menu
  const mobileToggle = document.querySelector('.mobile-menu-toggle');
  const navbarMenu = document.querySelector('.navbar-menu');
  
  if (mobileToggle && navbarMenu) {
    // Inject close button at top of menu
    const closeLi = document.createElement('li');
    closeLi.className = 'mobile-menu-close';
    closeLi.innerHTML = '<button aria-label="Close menu"><i class="fas fa-times"></i></button>';
    navbarMenu.insertBefore(closeLi, navbarMenu.firstChild);

    const navbar = document.querySelector('.navbar');

    const closeMobileMenu = () => {
      navbarMenu.classList.remove('mobile-active');
      if (navbar) navbar.classList.remove('menu-open');
      const icon = mobileToggle.querySelector('i');
      if (icon) icon.className = 'fas fa-bars';
      mobileToggle.setAttribute('aria-expanded', 'false');
    };

    const openMobileMenuNav = () => {
      navbarMenu.classList.add('mobile-active');
      if (navbar) navbar.classList.add('menu-open');
      const icon = mobileToggle.querySelector('i');
      if (icon) icon.className = 'fas fa-times';
      mobileToggle.setAttribute('aria-expanded', 'true');
    };

    mobileToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (navbarMenu.classList.contains('mobile-active')) {
        closeMobileMenu();
      } else {
        openMobileMenuNav();
      }
    });

    closeLi.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMobileMenu();
    });

    document.addEventListener('click', (event) => {
      if (!navbarMenu.classList.contains('mobile-active')) return;
      const clickedInsideMenu = !!event.target.closest('.navbar-menu');
      const clickedToggle = !!event.target.closest('.mobile-menu-toggle');
      if (!clickedInsideMenu && !clickedToggle) {
        closeMobileMenu();
      }
    });

    navbarMenu.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', closeMobileMenu);
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 767) {
        closeMobileMenu();
      }
    });
  }

  // Hardware back button — works in Capacitor APK (including remote-URL / Render mode)
  // NOTE: IS_NATIVE_CAPACITOR is evaluated at parse time and may be false when loading from a
  // remote server URL, so we check Capacitor availability at runtime here instead.
  try {
    // Cordova-style 'backbutton' event — fires in any Capacitor/Cordova WebView, safe to add unconditionally
    document.addEventListener('backbutton', function(e) {
      e.preventDefault();
      e.stopPropagation();
      const path = window.location.pathname || '/';
      const isHome = path === '/' || path === '/index.html' || path === '';
      if (!isHome) {
        window.history.back();
      } else {
        try {
          if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
            window.Capacitor.Plugins.App.exitApp();
          }
        } catch(ex) {}
      }
    }, false);

    // Capacitor App plugin listener — register now and also re-try on deviceready in case
    // the bridge wasn't ready when this script first executed (common with remote server.url)
    function _registerCapacitorBackButton() {
      try {
        if (window.Capacitor &&
            typeof window.Capacitor.isNativePlatform === 'function' &&
            window.Capacitor.isNativePlatform() &&
            window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          window.Capacitor.Plugins.App.addListener('backButton', function(data) {
            const path = window.location.pathname || '/';
            const isHome = path === '/' || path === '/index.html' || path === '';
            if (!isHome) {
              window.history.back();
            } else {
              window.Capacitor.Plugins.App.exitApp();
            }
          });
        }
      } catch(ex) {
        console.warn('Capacitor backButton registration error:', ex);
      }
    }

    _registerCapacitorBackButton();
    // Re-try after deviceready (bridge fully ready) — critical for remote-URL Capacitor apps
    document.addEventListener('deviceready', _registerCapacitorBackButton, false);
  } catch(e) {
    console.warn('Back button handler error:', e);
  }
}

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('Service Worker registered'))
      .catch(err => console.log('Service Worker registration failed:', err));
  });
}

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Load and apply custom logo
const SITE_LOGO_CACHE_KEY = 'site_logo_url_cache';
const SITE_LOGO_SIZE_CACHE_KEY = 'site_logo_size_cache';

function normalizeLogoSize(value, defaultSize) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return defaultSize;
  }
  return Math.max(20, Math.min(parsed, 80));
}

function preloadLogoImage(logoUrl) {
  if (!logoUrl) return;
  const existing = document.querySelector(`link[rel="preload"][as="image"][href="${logoUrl}"]`);
  if (existing) return;

  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'image';
  link.href = logoUrl;
  document.head.appendChild(link);
}

function applySiteLogo(logoUrl, logoSizeValue, logoSizeMobileValue) {
  const normalizedLogo = (logoUrl && logoUrl !== 'default') ? logoUrl : null;
  const isAdminRoute = window.location.pathname.startsWith('/admin');
  const defaultLogoSize = isAdminRoute ? 28 : 40;
  const defaultMobileSize = isAdminRoute ? 24 : 30;
  const desktopHeight = normalizeLogoSize(logoSizeValue, defaultLogoSize);
  const mobileHeight = logoSizeMobileValue ? Math.max(16, Math.min(parseInt(logoSizeMobileValue, 10) || defaultMobileSize, 60)) : defaultMobileSize;
  const desktopWidth = Math.round(desktopHeight * 4);
  const mobileWidth = Math.round(mobileHeight * 4);

  if (normalizedLogo) {
    preloadLogoImage(normalizedLogo);
  }

  // Inject/update a dynamic style tag for responsive logo sizing
  var styleId = '_logo-responsive-style';
  var styleEl = document.getElementById(styleId);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    .navbar-brand img.site-logo-dynamic { max-height: ${desktopHeight}px; max-width: ${desktopWidth}px; object-fit: contain; }
    @media (max-width: 767px) {
      .navbar-brand img.site-logo-dynamic { max-height: ${mobileHeight}px; max-width: ${mobileWidth}px; }
    }
  `;

  const navbarBrands = document.querySelectorAll('.navbar-brand');
  navbarBrands.forEach(brand => {
    const logoHtml = normalizedLogo
      ? `<img src="${normalizedLogo}" alt="Site Logo" class="site-logo-dynamic" decoding="async">`
      : '';

    const brandTextHtml = '';

    brand.innerHTML = `
      <span class="navbar-brand-main" style="display:inline-flex; align-items:center; gap:0.15rem; white-space:nowrap;">
        ${logoHtml}
        ${brandTextHtml}
      </span>
    `;
  });

  if (window.auth && typeof window.auth.updateDeliveryAddressUI === 'function') {
    window.auth.updateDeliveryAddressUI(true);
  }
}

async function loadSiteLogo() {
  try {
    const cachedLogo = localStorage.getItem(SITE_LOGO_CACHE_KEY);
    const cachedLogoSize = localStorage.getItem(SITE_LOGO_SIZE_CACHE_KEY);
    const cachedLogoSizeMobile = localStorage.getItem('site_logo_size_mobile');
    if (cachedLogo) {
      applySiteLogo(cachedLogo, cachedLogoSize, cachedLogoSizeMobile);
    }

    const response = await fetch(`${API_BASE}/products/settings`, {
      method: 'GET',
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      const settings = data.settings || {};
      const logoUrl = settings.logo_url && settings.logo_url !== 'default' ? settings.logo_url : '';
      const normalizedLogoSize = normalizeLogoSize(settings.logo_size, 40);
      const mobileLogoSize = settings.logo_size_mobile || '30';

      if (logoUrl) {
        localStorage.setItem(SITE_LOGO_CACHE_KEY, logoUrl);
      } else {
        localStorage.removeItem(SITE_LOGO_CACHE_KEY);
      }

      localStorage.setItem(SITE_LOGO_SIZE_CACHE_KEY, String(normalizedLogoSize));
      localStorage.setItem('site_logo_size_mobile', String(mobileLogoSize));

      applySiteLogo(logoUrl, normalizedLogoSize, mobileLogoSize);

      // Apply dynamic footer contact info
      applyFooterContact(settings);

      // Apply site notice / situation banner
      applySiteNoticeBanner(settings);
    }
  } catch (error) {
    // Silently fail - keep default logo
    console.log('Using default logo');
  }
}

// Load logo on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSiteLogo);
} else {
  loadSiteLogo();
}

function applyFooterContact(settings) {
  var email = (settings.contact_email || '').trim();
  var phone = (settings.contact_phone || '').trim();
  var location = (settings.contact_location || '').trim();

  var emailEl = document.getElementById('footer-contact-email');
  var phoneEl = document.getElementById('footer-contact-phone');
  var locationEl = document.getElementById('footer-contact-location');

  if (emailEl) {
    if (email) { emailEl.textContent = email; emailEl.parentElement.style.display = ''; }
    else { emailEl.parentElement.style.display = 'none'; }
  }
  if (phoneEl) {
    if (phone) { phoneEl.textContent = phone; phoneEl.parentElement.style.display = ''; }
    else { phoneEl.parentElement.style.display = 'none'; }
  }
  if (locationEl) {
    if (location) { locationEl.textContent = location; locationEl.parentElement.style.display = ''; }
    else { locationEl.parentElement.style.display = 'none'; }
  }
}

// ── Site Notice / Situation Reason Banner ─────────────────────────────────
const SITE_NOTICE_BAR_ID = 'site-notice-ticker-bar';

function applySiteNoticeBanner(settings) {
  // Only show on public-facing pages, not on admin dashboard
  if (window.location.pathname.startsWith('/admin')) return;

  const enabled = String(settings.site_notice_enabled || 'false').toLowerCase() === 'true';
  const text = String(settings.site_notice_text || '').trim();
  const color = String(settings.site_notice_color || '#1a472b').trim();

  // Remove existing bar if any
  const existing = document.getElementById(SITE_NOTICE_BAR_ID);
  if (existing) existing.remove();

  if (!enabled || !text) return;

  // Build the banner
  const bar = document.createElement('div');
  bar.id = SITE_NOTICE_BAR_ID;
  bar.style.cssText = [
    'position:relative',
    'z-index:10000',
    'width:100%',
    `background:linear-gradient(90deg,${color} 0%,${_lightenHexBanner(color,14)} 50%,${color} 100%)`,
    'color:#fff',
    'padding:0',
    'overflow:hidden',
    'border-bottom:2px solid rgba(255,255,255,0.15)',
    'box-shadow:0 2px 8px rgba(0,0,0,0.18)',
    'height:34px',
    'display:flex',
    'align-items:center',
  ].join(';');

  // Inner scrolling track
  const track = document.createElement('div');
  track.style.cssText = [
    'display:flex',
    'align-items:center',
    'white-space:nowrap',
    'will-change:transform',
    'animation:siteNoticeTicker 28s linear infinite',
    'font-size:0.84rem',
    'font-weight:600',
    'letter-spacing:0.01em',
    'padding:0 1rem',
    'gap:3rem',
  ].join(';');

  // Repeat text 4 times for seamless loop
  const icon = '\u26a0\ufe0f\u00a0';
  const spacer = '\u00a0\u00a0\u00a0\u00a0\u2022\u00a0\u00a0\u00a0\u00a0';
  const fullText = icon + text;
  track.textContent = [fullText, fullText, fullText, fullText].join(spacer);
  bar.appendChild(track);

  // Inject keyframe style once
  if (!document.getElementById('_site-notice-style')) {
    const style = document.createElement('style');
    style.id = '_site-notice-style';
    style.textContent = '@keyframes siteNoticeTicker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}';
    document.head.appendChild(style);
  }

  // Insert before <body>'s first child (above everything incl. navbar)
  const body = document.body;
  if (body.firstChild) {
    body.insertBefore(bar, body.firstChild);
  } else {
    body.appendChild(bar);
  }
}

// Slightly lighten a hex colour for gradient midpoint in the notice banner
function _lightenHexBanner(hex, amount) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  return '#' + [0, 2, 4].map(i => {
    const v = Math.min(255, parseInt(h.slice(i, i + 2), 16) + amount);
    return v.toString(16).padStart(2, '0');
  }).join('');
}

// Export for use in other scripts
window.api = api;
window.auth = auth;
window.cart = cart;
window.showAlert = showAlert;
window.formatCurrency = formatCurrency;
window.formatDate = formatDate;
window.formatDateTime = formatDateTime;
window.openModal = openModal;
window.closeModal = closeModal;
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.uploadProductImage = uploadProductImage;
window.validateImageFile = validateImageFile;
window.loadSiteLogo = loadSiteLogo;
window.openProfileModal = openProfileModal;
window.openAccountManagementModal = openAccountManagementModal;
window.optimizeDynamicImages = optimizeDynamicImages;
// Restore database handler for admin.html
window.handleRestoreDatabase = async function(event) {
  event.preventDefault();
  const fileInput = document.getElementById('restore-sqlfile');
  const restoreForm = document.getElementById('restore-form');
  const statusEl = document.getElementById('restore-status');
  const submitBtn = restoreForm?.querySelector('button[type="submit"]');
  const file = fileInput?.files?.[0];
  if (!file) {
    showAlert('Please select a .sql file to restore.', 'error');
    return;
  }

  const setRestoreStatus = (message, type = 'info') => {
    if (!statusEl) return;
    const palette = {
      info: '#2563eb',
      success: '#15803d',
      error: '#b91c1c'
    };
    statusEl.textContent = message;
    statusEl.style.color = palette[type] || palette.info;
  };

  const formData = new FormData();
  formData.append('sqlfile', file);

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Restoring...';
  }

  try {
    showAlert('Restoring database...', 'info');
    setRestoreStatus('Restoring database... Please wait.', 'info');
    const token = localStorage.getItem('token');
    const response = await fetch(`${API_BASE}/restore`, {
      method: 'POST',
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include'
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      data = { error: raw || 'Restore failed' };
    }

    if (response.ok) {
      const restored = data?.verification?.usersCount;
      const expected = data?.verification?.expectedUsersFromBackup;
      const backendMessage = data?.message || 'Database restored successfully.';
      const details = (typeof restored === 'number')
        ? ` Restored users: ${restored}${typeof expected === 'number' ? ` (backup users: ${expected})` : ''}.`
        : '';
      const successMessage = `${backendMessage}${details}`;
      if (typeof window.showSuccessModal === 'function') {
        window.showSuccessModal(successMessage);
      }
      showAlert('Database restored successfully', 'success');
      setRestoreStatus('Database restored successfully.', 'success');
      if (fileInput) fileInput.value = '';
    } else {
      if (response.status === 401 || response.status === 403) {
        showAlert('Restore denied. Please login as Super Admin and try again.', 'error');
        setRestoreStatus('Restore denied. Please login as Super Admin and try again.', 'error');
      } else {
        showAlert(data.error || 'Restore failed', 'error');
        setRestoreStatus(data.error || 'Restore failed.', 'error');
      }
    }
  } catch (error) {
    showAlert(error.message || 'Restore failed', 'error');
    setRestoreStatus(error.message || 'Restore failed.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fas fa-upload"></i> Restore';
    }
  }
};