const express = require('express');
const router = express.Router();
const invoiceController = require('./invoice.controller');
const authMiddleware = require('../../middleware/authMiddleware');
const { validateRequest } = require('../../middleware/validate.middleware');
const invoiceSchemas = require('./invoice.validation');

// Vendor routes
router.get('/vendor', authMiddleware(['vendor']), invoiceController.getVendorInvoices);
router.post('/vendor/orders/:orderId', authMiddleware(['vendor']), validateRequest(invoiceSchemas.createInvoiceSchema), invoiceController.createVendorInvoice);

// Admin routes
router.get('/admin', authMiddleware(['admin']), invoiceController.getAdminInvoices);
router.delete('/admin/:id', authMiddleware(['admin']), invoiceController.deleteAdminInvoice);

// Service Invoice routes
router.get('/service-bookings/pending', authMiddleware(['admin']), invoiceController.getPendingServiceBookings);
router.post('/service', authMiddleware(['admin']), invoiceController.createServiceInvoice);
router.get('/service/:bookingId/download', authMiddleware(['customer', 'admin', 'technician', 'partner']), invoiceController.downloadServiceInvoice);
router.get('/service/:bookingId/commission-invoice/download', authMiddleware(['admin']), invoiceController.downloadPartnerCommissionInvoice);

// Product Order Invoice routes
router.get('/orders/:orderId/download', authMiddleware(['customer', 'admin', 'vendor']), invoiceController.downloadOrderInvoice);

module.exports = router;
