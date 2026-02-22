// Mountain Made 2.0 - Main JavaScript Utilities

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
        throw new Error((data && data.error) || 'Request failed');
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
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
      const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif'];
      const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
      
      if (!allowedTypes.includes(file.type) || !allowedExtensions.includes(fileExtension)) {
        throw new Error('Invalid file type. Only JPG, PNG, and GIF images are allowed.');
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
      btn.textContent = text;
    });
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

    if (!this.isAuthenticated() || this.isAdmin()) {
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
    const locationText = primaryArea || line1 || 'Add delivery address';

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
      const accountSection = dropdown.querySelector('.account-section');
      if (!accountSection) return;

      let identityEl = accountSection.querySelector('.account-user-name');

      if (!this.isAuthenticated()) {
        if (identityEl) identityEl.remove();
        return;
      }

      if (!identityEl) {
        identityEl = document.createElement('div');
        identityEl.className = 'account-text account-user-name';

        const firstAction = accountSection.querySelector('.account-link');
        if (firstAction) {
          accountSection.insertBefore(identityEl, firstAction);
        } else {
          accountSection.appendChild(identityEl);
        }
      }

      const name = String(this.currentUser?.full_name || this.currentUser?.email || 'User').trim();
      identityEl.textContent = name;
    });
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

      console.log('Adding product to cart:', productId);
      const response = await api.post('/cart/add', { product_id: productId, quantity });
      console.log('Cart add response:', response);
      
      if (response && response.success !== false) {
        await this.fetch();
        // Only show alert if not in direct buy flow
        if (!sessionStorage.getItem('directBuy')) {
          showAlert('✓ Product added to cart!', 'success');
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
function showAlert(message, type = 'info') {
  const alertContainer = document.getElementById('alert-container') || createAlertContainer();
  
  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  alert.style.cssText = 'padding: 1rem; margin-bottom: 0.5rem; border-radius: 0.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.1); transition: opacity 0.3s;';
  
  alert.innerHTML = `<span>${message}</span>`;
  
  alertContainer.appendChild(alert);
  
  setTimeout(() => {
    alert.style.opacity = '0';
    setTimeout(() => alert.remove(), 300);
  }, 3000);
}

function createAlertContainer() {
  const container = document.createElement('div');
  container.id = 'alert-container';
  container.style.cssText = 'position: fixed; top: 100px; right: 20px; z-index: 10000; display: flex; flex-direction: column; gap: 10px; max-width: 400px;';
  document.body.appendChild(container);
  return container;
}

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
      .profile-modal-dialog { background: var(--background, #fff); border-radius: 12px; max-width: 480px; width: 95%; padding: 1.5rem; box-shadow: 0 20px 40px rgba(0,0,0,0.15); border: 1px solid var(--border, #e5e7eb); }
      .profile-modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
      .profile-avatar-preview { width: 80px; height: 80px; border-radius: 50%; background: #f1f5f9; border: 2px dashed var(--border, #cbd5e1); display: grid; place-items: center; color: var(--text-light, #64748b); font-weight: 700; overflow: hidden; }
      .profile-avatar-preview.has-photo { border-style: solid; background-size: cover; background-position: center; color: transparent; }
      .profile-avatar-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
      .profile-modal-sub { color: var(--text-light, #6b7280); margin-top: 0; margin-bottom: 1rem; }
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
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
  const allowedExtensions = ['.jpg', '.jpeg', '.png'];
  const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
  

  
  if (!allowedTypes.includes(file.type) || !allowedExtensions.includes(fileExtension)) {
    return { valid: false, error: 'Invalid file type. Only JPG and PNG images are allowed.' };
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
    const closeMobileMenu = () => {
      navbarMenu.classList.remove('mobile-active');
    };

    mobileToggle.addEventListener('click', () => {
      navbarMenu.classList.toggle('mobile-active');
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

  // Global back button on non-home pages (excluding wholesale dashboard)
  try {
    const existingBack = document.querySelector('.page-back-button');
    const hasLocalBackButton = document.querySelector('[data-back-button], .section-back-button, #back-btn, button[onclick*="navigateBack"]');
    const hasNavbar = document.querySelector('.navbar');
    const path = window.location.pathname || '/';
    const isHome = path === '/' || path === '/index.html';
    const isWholesaleDashboard = path === '/wholesale' || path === '/wholesale.html';

    if (!existingBack && !hasLocalBackButton && hasNavbar && !isHome && !isWholesaleDashboard) {
      const backBtn = document.createElement('button');
      backBtn.className = 'page-back-button btn-sm';
      backBtn.type = 'button';
      backBtn.innerHTML = '<i class="fas fa-arrow-left"></i><span>Back</span>';

      backBtn.addEventListener('click', () => {
        if (window.history.length > 1) {
          window.history.back();
        } else {
          window.location.href = document.referrer || '/';
        }
      });

      document.body.appendChild(backBtn);
    }
  } catch (e) {
    console.warn('Back button init failed:', e);
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

function applySiteLogo(logoUrl) {
  const normalizedLogo = (logoUrl && logoUrl !== 'default') ? logoUrl : null;
  const brandTextImagePath = '/images/brand-text.png';
  const isAdminRoute = window.location.pathname.startsWith('/admin');

  if (normalizedLogo) {
    preloadLogoImage(normalizedLogo);
  }

  const navbarBrands = document.querySelectorAll('.navbar-brand');
  navbarBrands.forEach(brand => {
    const logoHtml = normalizedLogo
      ? `<img src="${normalizedLogo}" alt="Site Logo" style="max-height: ${isAdminRoute ? '28px' : '40px'}; max-width: ${isAdminRoute ? '110px' : '160px'}; object-fit: contain;" decoding="async">`
      : `<span class="logo-icon">🏔️</span>`;

    const textImageHtml = isAdminRoute
      ? `<img src="${brandTextImagePath}" alt="Brand Text" style="height: 28px; max-width: 210px; width: auto; object-fit: contain; display: block;" onerror="this.style.display='none';">`
      : `<img src="${brandTextImagePath}" alt="Brand Text" style="height: clamp(26px, 5.5vw, 36px); max-width: min(64vw, 340px); width: auto; object-fit: contain; display: block;" onerror="this.style.display='none';">`;

    brand.innerHTML = `
      <span class="navbar-brand-main" style="display:inline-flex; align-items:center; gap:0.15rem; white-space:nowrap;">
        ${logoHtml}
        ${textImageHtml}
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
    if (cachedLogo) {
      applySiteLogo(cachedLogo);
    }

    const response = await fetch(`${API_BASE}/products/settings`, {
      method: 'GET',
      credentials: 'include'
    });
    
    if (response.ok) {
      const data = await response.json();
      const settings = data.settings || {};
      const logoUrl = settings.logo_url && settings.logo_url !== 'default' ? settings.logo_url : '';

      if (logoUrl) {
        localStorage.setItem(SITE_LOGO_CACHE_KEY, logoUrl);
      } else {
        localStorage.removeItem(SITE_LOGO_CACHE_KEY);
      }

      applySiteLogo(logoUrl);
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