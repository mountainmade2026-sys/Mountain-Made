const isAdminLike = (role) => role === 'admin' || role === 'super_admin';

const blockAdminCommerce = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  if (isAdminLike(req.user.role)) {
    return res.status(403).json({ error: 'Admin accounts are for management only and cannot use cart or place orders.' });
  }

  next();
};

module.exports = { blockAdminCommerce };
