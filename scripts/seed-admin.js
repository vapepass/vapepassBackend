import dotenv from 'dotenv';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import { ROLES } from '../src/utils/constants.js';
import { env } from '../src/config/env.js';

dotenv.config();

const email = process.env.ADMIN_EMAIL || 'admin@vapepass.com';
const password = process.env.ADMIN_PASSWORD || 'AdminPass123';

async function seedAdmin() {
  await mongoose.connect(env.mongoUri);

  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.role !== ROLES.ADMIN) {
      existing.role = ROLES.ADMIN;
      await existing.save();
      console.log(`Updated existing user ${email} to admin role`);
    } else {
      console.log(`Admin user already exists: ${email}`);
    }
    await mongoose.disconnect();
    return;
  }

  await User.create({
    firstName: 'VapePass',
    lastName: 'Admin',
    email,
    password,
    role: ROLES.ADMIN,
    storeId: null,
  });

  console.log(`Admin user created: ${email}`);
  console.log('Password:', password);
  await mongoose.disconnect();
}

seedAdmin().catch((err) => {
  console.error(err);
  process.exit(1);
});
