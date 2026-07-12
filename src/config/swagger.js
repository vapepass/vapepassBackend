import swaggerJsdoc from 'swagger-jsdoc';
import { env } from './env.js';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'VapePass API',
      version: '1.0.0',
      description:
        'REST API for VapePass — a digital loyalty card platform for vape stores.',
      contact: {
        name: 'VapePass Support',
      },
    },
    servers: [
      {
        url: `http://localhost:${env.port}/api/v1`,
        description: 'Local development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'refreshToken',
        },
      },
      schemas: {
        ApiResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            message: { type: 'string', example: 'Operation successful' },
            data: { type: 'object' },
          },
        },
        ApiError: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            message: { type: 'string', example: 'Validation failed' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            firstName: { type: 'string', example: 'Jane' },
            lastName: { type: 'string', example: 'Doe' },
            email: { type: 'string', format: 'email', example: 'jane@store.com' },
            role: {
              type: 'string',
              enum: ['admin', 'store_owner', 'employee'],
              example: 'store_owner',
            },
            storeId: { type: 'string', nullable: true },
            isActive: { type: 'boolean', example: true },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Store: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string', example: 'Cloud Nine Vapes' },
            logo: { type: 'string', nullable: true },
            brandColor: { type: 'string', example: '#6C3CE1' },
            rewardDescription: { type: 'string', example: 'Free e-liquid after 10 stamps' },
            stampGoal: { type: 'integer', example: 10 },
            subscriptionStatus: {
              type: 'string',
              enum: ['trial', 'active', 'past_due', 'cancelled'],
              example: 'trial',
            },
            address: { type: 'string', nullable: true, example: '1234 Robson St, Vancouver, BC' },
            country: { type: 'string', example: 'CA' },
            province: { type: 'string', nullable: true, example: 'BC' },
            legalAge: { type: 'integer', example: 19, description: 'Auto-calculated from location' },
            createdBy: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        RegisterInput: {
          type: 'object',
          required: ['firstName', 'lastName', 'email', 'password'],
          properties: {
            firstName: { type: 'string', example: 'Jane' },
            lastName: { type: 'string', example: 'Doe' },
            email: { type: 'string', format: 'email', example: 'jane@store.com' },
            password: { type: 'string', format: 'password', minLength: 8 },
            role: {
              type: 'string',
              enum: ['store_owner', 'employee'],
              example: 'store_owner',
            },
            storeName: {
              type: 'string',
              example: 'Cloud Nine Vapes',
              description: 'Required when role is store_owner',
            },
            country: { type: 'string', example: 'CA' },
            province: { type: 'string', example: 'BC' },
            address: { type: 'string', example: '1234 Robson St, Vancouver, BC' },
          },
        },
        LoginInput: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', format: 'password' },
          },
        },
        StoreSettingsInput: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            brandColor: { type: 'string', example: '#6C3CE1' },
            rewardDescription: { type: 'string' },
            stampGoal: { type: 'integer', minimum: 1, maximum: 50 },
            address: { type: 'string' },
            country: { type: 'string', example: 'CA' },
            province: { type: 'string', example: 'BC' },
          },
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Authentication and user profile' },
      { name: 'Store', description: 'Store management' },
    ],
  },
  apis: ['./src/routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
