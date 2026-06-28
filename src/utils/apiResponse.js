/**
 * Standard API success response.
 */
export const sendSuccess = (res, statusCode, message, data = null) => {
  const response = { success: true, message };

  if (data !== null && data !== undefined) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
};

/**
 * Standard API error response.
 */
export const sendError = (res, statusCode, message, errors = null) => {
  const response = { success: false, message };

  if (errors) {
    response.errors = errors;
  }

  return res.status(statusCode).json(response);
};
