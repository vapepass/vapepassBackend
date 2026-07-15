/** Minimal valid store-owner registration payload for tests */
export function registerPayload(overrides = {}) {
  return {
    firstName: 'Jane',
    lastName: 'Doe',
    ownerName: 'Jane Doe',
    email: 'jane@store.com',
    phone: '+16045550100',
    password: 'SecurePass1',
    storeName: 'Cloud Nine Vapes',
    websiteUrl: 'https://cloudnine.example.com',
    country: 'CA',
    province: 'BC',
    city: 'Vancouver',
    address: '123 Main Street',
    subscriptionPlan: 'pro',
    ...overrides,
  };
}
