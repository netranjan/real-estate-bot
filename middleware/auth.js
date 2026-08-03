// middleware/auth.js
module.exports = {
  // Protect routes: user must be logged in
  requireLogin: (req, res, next) => {
    if (req.session && req.session.userId) return next();
    // Save the original URL so we can redirect after login
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/login');
  },

  // Require a specific role
  requireRole: (...roles) => {
    return (req, res, next) => {
      if (!req.session || !req.session.userId) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/auth/login');
      }
      if (!roles.includes(req.session.userRole)) {
        return res.status(403).send('Access denied');
      }
      next();
    };
  },

  // Set user data into res.locals for views
  setLocals: (req, res, next) => {
    if (req.session && req.session.userId) {
      res.locals.currentUser = {
        id: req.session.userId,
        username: req.session.username,
        role: req.session.userRole,
        displayName: req.session.displayName,
        clientId: req.session.clientId
      };
    } else {
      res.locals.currentUser = null;
    }
    next();
  }
};