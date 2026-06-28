/**
 * Strip sensitive fields from a Mongoose user document.
 */
export const sanitizeUser = (user) => {
  if (!user) return null;

  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.password;
  delete obj.refreshToken;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.__v;

  return obj;
};
