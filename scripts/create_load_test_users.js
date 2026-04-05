/**
 * Creates 5 test accounts for load testing.
 * Run: node scripts/create_load_test_users.js
 * Safe to run multiple times (uses upsert).
 */

require('dotenv').config();
const User = require('../models/User');

const TEST_USERS = [
  { full_name: 'Load Test 1', email: 'loadtest1@gmail.com', password: 'LoadTest@123', phone: '910000000001' },
  { full_name: 'Load Test 2', email: 'loadtest2@gmail.com', password: 'LoadTest@123', phone: '910000000002' },
  { full_name: 'Load Test 3', email: 'loadtest3@gmail.com', password: 'LoadTest@123', phone: '910000000003' },
  { full_name: 'Load Test 4', email: 'loadtest4@gmail.com', password: 'LoadTest@123', phone: '910000000004' },
  { full_name: 'Load Test 5', email: 'loadtest5@gmail.com', password: 'LoadTest@123', phone: '910000000005' },
];

(async () => {
  for (const u of TEST_USERS) {
    try {
      const user = await User.ensureUser({ ...u, role: 'customer' });
      console.log(`✓ ${user.email}  (id=${user.id})`);
    } catch (err) {
      console.error(`✗ ${u.email}: ${err.message}`);
    }
  }
  process.exit(0);
})();
