const Product = require('../models/Product');
const db = require('../config/database');

exports.getAllProducts = async (req, res) => {
  try {
    const { category_id, search, min_price, max_price, limit, offset } = req.query;

    // Base filters (without price range) to compute dynamic price bounds
    const baseFilters = {
      category_id,
      search,
      limit: null,
      offset: null
    };

    const allForRange = await Product.findAll(baseFilters);
    let priceRange = null;

    if (allForRange.length > 0) {
      const prices = allForRange
        .map(p => (p.price != null ? parseFloat(p.price) : null))
        .filter(v => Number.isFinite(v));

      if (prices.length > 0) {
        priceRange = {
          min: Math.min(...prices),
          max: Math.max(...prices)
        };
      }
    }

    const minPriceNum = min_price !== undefined ? parseFloat(min_price) : null;
    const maxPriceNum = max_price !== undefined ? parseFloat(max_price) : null;

    const filters = {
      category_id,
      search,
      min_price: Number.isFinite(minPriceNum) ? minPriceNum : null,
      max_price: Number.isFinite(maxPriceNum) ? maxPriceNum : null,
      limit: limit ? parseInt(limit) : null,
      offset: offset ? parseInt(offset) : null
    };

    const products = await Product.findAll(filters);
    res.json({ products, priceRange });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products.' });
  }
};

// Search suggestions for homepage search bar (products + categories)
exports.getSearchSuggestions = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();

    if (!q) {
      return res.json({ suggestions: [] });
    }

    const term = `%${q}%`;

    const [productResult, categoryResult] = await Promise.all([
      db.query(
        `SELECT id, name, image_url, price, discount_price
         FROM products
         WHERE COALESCE(is_active, true) = true AND name ILIKE $1
         ORDER BY created_at DESC
         LIMIT 5`,
        [term]
      ),
      db.query(
        `SELECT id, name, image_url
         FROM categories
         WHERE name ILIKE $1
         ORDER BY name ASC
         LIMIT 5`,
        [term]
      )
    ]);

    const suggestions = [
      ...productResult.rows.map(p => ({
        type: 'product',
        id: p.id,
        name: p.name,
        image_url: p.image_url,
        price: p.price,
        discount_price: p.discount_price
      })),
      ...categoryResult.rows.map(c => ({
        type: 'category',
        id: c.id,
        name: c.name,
        image_url: c.image_url
      }))
    ];

    res.json({ suggestions });
  } catch (error) {
    console.error('Get search suggestions error:', error);
    res.status(500).json({ error: 'Failed to fetch search suggestions.' });
  }
};

exports.getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    res.json({ product });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to fetch product.' });
  }
};

exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Product.getAllCategories();
    res.json({ categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories.' });
  }
};

exports.getProductsByCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const products = await Product.findAll({ category_id: id });
    const category = await Product.getCategoryById(id);

    res.json({ 
      category,
      products 
    });
  } catch (error) {
    console.error('Get products by category error:', error);
    res.status(500).json({ error: 'Failed to fetch products.' });
  }
};

exports.getHomepageSections = async (req, res) => {
  try {
    const query = `
      SELECT 
        hs.id,
        hs.name,
        hs.description,
        hs.heading_image_url,
        hs.sort_order,
        json_agg(
          json_build_object(
            'id', p.id,
            'name', p.name,
            'description', p.description,
              'price', p.price,
              'discount_price', p.discount_price,
              'discount_percentage', p.discount_percentage,
              'wholesale_price', p.wholesale_price,
            'stock_quantity', p.stock_quantity,
            'image_url', p.image_url,
            'images', p.images,
            'unit', p.unit,
            'category_id', p.category_id,
            'min_wholesale_qty', p.min_wholesale_qty
          ) ORDER BY p.created_at DESC
        ) FILTER (WHERE p.id IS NOT NULL) as products
      FROM homepage_sections hs
      LEFT JOIN products p ON hs.id = p.homepage_section_id AND COALESCE(p.is_active, true) = true
      WHERE hs.is_active = true
      GROUP BY hs.id, hs.name, hs.description, hs.heading_image_url, hs.sort_order
      ORDER BY hs.sort_order ASC, hs.created_at ASC
    `;
    
    const result = await db.query(query);
    res.json({ sections: result.rows });
  } catch (error) {
    console.error('Get homepage sections error:', error);
    res.status(500).json({ error: 'Failed to fetch homepage sections.' });
  }
};

exports.getSiteSettings = async (req, res) => {
  try {
    const result = await db.query('SELECT setting_key, setting_value FROM site_settings');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });
    res.json({ settings });
  } catch (error) {
    console.error('Get site settings error:', error);
    res.json({ settings: {} }); // Return empty settings on error
  }
};
