import { validationResult } from 'express-validator';
import { sendError } from '../utils/apiResponse.js';

/**
 * Runs express-validator chains and returns formatted errors if validation fails.
 */
export const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map((validation) => validation.run(req)));

    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      const formattedErrors = errors.array().map((err) => ({
        field: err.path,
        message: err.msg,
      }));

      return sendError(res, 422, 'Validation failed', formattedErrors);
    }

    next();
  };
};
