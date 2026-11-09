const { Invoice, InvoiceItem, Order, OrderItem, Vendor, Product, Customer, ServiceBooking, Service, ExtraItemsRequest } = require('../../models');
const AppError = require('../../utils/AppError');
const { buildInvoicePdf, generateInvoicePdfBuffer } = require('../../utils/pdfGenerator');
const { getGstStateCode } = require('../../utils/gstStateCodes');
const { uploadPdfStreamToCloudinary } = require('../../utils/cloudinary');

const createVendorInvoice = async (vendor_id, orderId, items) => {
  const order = await Order.findOne({
    where: { order_number: orderId },
    include: [{ model: Customer, as: 'customer' }]
  });

  if (!order) {
    throw new AppError('Order not found', 404);
  }

  const orderItems = await OrderItem.findAll({
    where: { order_id: order.id, vendor_id },
    include: [{ model: Product, as: 'product' }]
  });

  if (!orderItems || orderItems.length === 0) {
    throw new AppError('Order items not found for this vendor', 404);
  }

  const invoice_number = 'INV' + Date.now() + Math.floor(Math.random() * 1000);
  let total_payout_taxable = 0;
  let total_payout_tax = 0;
  const invoiceItemsData = [];

  for (const orderItem of orderItems) {
    const payloadItem = items.find(i => i.id === orderItem.id);
    if (!payloadItem) {
      throw new AppError(`Missing details for item: ${orderItem.product_id}`, 400);
    }

    const qty = orderItem.qty || 1;
    const slab = orderItem.tax_slab != null ? Number(orderItem.tax_slab) : 18;

    let unitPayout = 0;
    if (orderItem.vendor_payout != null && qty > 0) {
      unitPayout = parseFloat((parseFloat(orderItem.vendor_payout) / qty).toFixed(2));
    } else if (orderItem.product && orderItem.product.base_price != null) {
      const base = parseFloat(orderItem.product.base_price) || 0;
      const disc = parseFloat(orderItem.product.discount) || 0;
      unitPayout = parseFloat((base * (1 - disc / 100)).toFixed(2));
    } else {
      const sub = parseFloat(orderItem.subtotal || 0);
      const comm = parseFloat(orderItem.admin_commission || 0);
      const net = sub - (sub * (comm / 100));
      unitPayout = parseFloat((net / qty).toFixed(2));
    }

    // Vendor base price is tax-inclusive. Reverse-calculate taxable amount and tax.
    const unitPayoutInclTax = unitPayout;
    const unitPayoutExclTax = parseFloat((unitPayoutInclTax / (1 + (slab / 100))).toFixed(2));
    const itemPayoutAmount = parseFloat((unitPayoutExclTax * qty).toFixed(2));
    const itemPayoutTotal = parseFloat((unitPayoutInclTax * qty).toFixed(2));
    const itemPayoutTax = parseFloat((itemPayoutTotal - itemPayoutAmount).toFixed(2));

    total_payout_taxable += itemPayoutAmount;
    total_payout_tax += itemPayoutTax;

    invoiceItemsData.push({
      description: payloadItem.productName || (orderItem.product ? orderItem.product.name : 'Product'),
      qty,
      rate: unitPayoutInclTax,
      amount: itemPayoutAmount,
      warranty: payloadItem.warranty || '',
      model_number: payloadItem.modelNumber || '',
      hsn_code: payloadItem.hsnCode || '',
      serial_numbers: payloadItem.serialNumbers || []
    });
    
    orderItem.status = 'ACCEPTED';
    await orderItem.save();
  }

  const grand_total = parseFloat((total_payout_taxable + total_payout_tax).toFixed(2));

  const invoice = await Invoice.create({
    invoice_number,
    order_id: order.order_number || orderId,
    vendor_id,
    customer_name: order.customer_name || (order.customer ? order.customer.full_name : 'N/A'),
    mobile: order.customer_contact || (order.customer ? order.customer.mobile : 'N/A'),
    email: order.customer ? order.customer.email : '',
    address: order.customer_address,
    additional_charges: 0,
    gst_percent: 18,
    grand_total,
    status: 'Paid',
    type: 'VENDOR'
  });

  for (const invItem of invoiceItemsData) {
    invItem.invoice_id = invoice.id;
    await InvoiceItem.create(invItem);
  }

  order.status = 'ACCEPTED';
  await order.save();

  return invoice;
};

const getAdminInvoices = async () => {
  const invoices = await Invoice.findAll({
    include: [
      { model: InvoiceItem, as: 'items' },
      { model: Vendor, as: 'vendor', attributes: ['id', 'business_name', 'full_name', 'gst_number', 'gst_state_code'] }
    ],
    order: [['createdAt', 'DESC']]
  });

  const formatted = await Promise.all(invoices.map(async (inv) => {
    const json = inv.toJSON ? inv.toJSON() : inv;
    if (json.type === 'SERVICE' && json.order_id && (json.order_id.startsWith('BKG-') || json.order_id.startsWith('SR-'))) {
      try {
        const autoId = parseInt(json.order_id.split('-')[1]) - 1000;
        const booking = await ServiceBooking.findOne({
          where: { auto_id: autoId },
          include: [{ model: Service }]
        });
        if (booking && booking.Service) {
          json.service_name = booking.Service.name;
          json.is_partner = (booking.Service.service_owner_type === 'PARTNER') || (booking.metadata?.service_owner_type === 'PARTNER');
        }
      } catch (err) {
        console.error('Error resolving service name for invoice:', err);
      }
    }

    if (json.type === 'VENDOR') {
      json.sold_by = json.vendor ? (json.vendor.business_name || json.vendor.full_name) : 'Assure Technologies';
      json.vendor_gstin = json.vendor ? json.vendor.gst_number : '';
      json.vendor_gst_state_code = json.vendor ? (json.vendor.gst_state_code || (json.vendor.gst_number ? json.vendor.gst_number.slice(0, 2) : '37')) : '37';
      json.product_name = (json.items && json.items.length > 0 && json.items[0].description)
        ? json.items.map(i => i.description).filter(Boolean).join(', ')
        : 'Product';
    } else {
      json.sold_by = 'Assure Technologies';
    }

    json.is_manual = Boolean(json.is_manual);
    json.isManual = Boolean(json.is_manual);
    json.tax_type = json.tax_type || (json.gst_number && !json.gst_number.startsWith('37') ? 'IGST' : 'GST');

    return json;
  }));

  return formatted;
};

const deleteAdminInvoice = async (id) => {
  const invoice = await Invoice.findByPk(id);
  if (!invoice) throw new AppError('Invoice not found', 404);
  await invoice.destroy();
};

const createServiceInvoice = async (invoiceData) => {
  const {
    srNo,
    customerName,
    customer_name,
    mobile,
    email,
    companyName,
    company_name,
    gstNumber,
    gst_number,
    address,
    pincode,
    items,
    additionalChargesDesc,
    additional_charges_desc,
    additionalCharges,
    additional_charges,
    gstPercent,
    gst_percent,
    grandTotal,
    grand_total,
    termsAndConditions,
    terms_and_conditions,
    serviceName
  } = invoiceData;

  let booking = null;
  if (srNo && typeof srNo === 'string' && srNo.includes('-')) {
    const rawNumber = srNo.startsWith('SR-') ? srNo.replace('SR-', '') : (srNo.startsWith('BKG-') ? srNo.replace('BKG-', '') : srNo.split('-')[1]);
    const autoId = parseInt(rawNumber, 10) - 1000;
    if (!isNaN(autoId)) {
      booking = await ServiceBooking.findOne({
        where: { auto_id: autoId },
        include: [
          { model: Service },
          { model: Order }
        ]
      });
    }
  }

  // Validate base service payload against DB truth if booking exists
  if (items && items.length > 0 && booking) {
    const trueQty = booking.quantity ? parseFloat(booking.quantity) : 1;
    const trueRate = (booking.Order && booking.Order.subtotal_amount && trueQty) ? parseFloat(booking.Order.subtotal_amount) / trueQty : (booking.Service ? parseFloat(booking.Service.prebooking_charge) : 0);
    
    const payloadQty = parseFloat(items[0].qty) || 0;
    const payloadRate = parseFloat(items[0].rate) || 0;

    if (payloadQty !== trueQty || payloadRate !== trueRate) {
      throw new AppError('Base service quantity and rate cannot be modified.', 400);
    }
  }

  const { Op } = require('sequelize');
  const isManual = Boolean(invoiceData.isManual || invoiceData.is_manual);

  let invoice_number = invoiceData.invoiceNumber || invoiceData.invoice_number;
  if (!invoice_number) {
    if (isManual) {
      const todayStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
      const countToday = await Invoice.count({
        where: {
          invoice_number: { [Op.like]: `INV-${todayStr}-%` }
        }
      });
      const seq = String(countToday + 1).padStart(3, '0');
      invoice_number = `INV-${todayStr}-${seq}`;
    } else {
      invoice_number = 'INV' + Date.now() + Math.floor(Math.random() * 1000);
    }
  }

  // Calculate remaining balance based on what was already paid in the Order
  const orderTotal = booking && booking.Order ? parseFloat(booking.Order.total_amount) : 0;
  const grandTotalParsed = parseFloat(grandTotal || grand_total || 0);
  let balance = grandTotalParsed - orderTotal;
  if (balance < 1) balance = 0;

  const invoice = await Invoice.create({
    invoice_number,
    order_id: srNo || invoice_number,
    customer_name: customerName || customer_name || 'N/A',
    mobile: mobile || 'N/A',
    email: email || '',
    company_name: companyName || company_name || null,
    gst_number: gstNumber || gst_number || null,
    address: address || '',
    pincode: pincode || null,
    additional_charges_desc: additionalChargesDesc || additional_charges_desc || '',
    additional_charges: additionalCharges !== undefined ? additionalCharges : (additional_charges || 0),
    gst_percent: (booking?.Service?.service_owner_type === 'PARTNER') ? 0 : (gstPercent !== undefined ? gstPercent : (gst_percent !== undefined ? gst_percent : (booking?.Service?.tax_rate ? parseFloat(booking.Service.tax_rate) : 18))),
    grand_total: (booking?.Service?.service_owner_type === 'PARTNER') ? (parseFloat(booking.Order?.subtotal_amount) || grandTotalParsed) : grandTotalParsed,
    terms_and_conditions: termsAndConditions || terms_and_conditions || null,
    status: balance > 0 ? 'Pending' : 'Paid',
    type: 'SERVICE',
    is_manual: isManual,
    tax_type: invoiceData.tax_type || invoiceData.taxType || 'GST'
  });

  if (items && items.length > 0) {
    for (const item of items) {
      const desc = item.description || item.service_name || item.name || serviceName || 'Service';
      const qty = parseInt(item.qty, 10) || 1;
      const rate = parseFloat(item.rate !== undefined ? item.rate : (item.cost !== undefined ? item.cost : 0)) || 0;
      const amount = parseFloat(item.amount !== undefined ? item.amount : (item.total !== undefined ? item.total : rate * qty)) || 0;

      await InvoiceItem.create({
        invoice_id: invoice.id,
        description: desc,
        qty,
        rate,
        amount,
        warranty: item.warranty || '',
        model_number: item.modelNumber || item.model_number || '',
        hsn_code: item.hsnCode || item.hsn_code || '',
        serial_numbers: Array.isArray(item.serialNumbers) ? JSON.stringify(item.serialNumbers) : (Array.isArray(item.serial_numbers) ? JSON.stringify(item.serial_numbers) : (item.serialNumbers || item.serial_numbers || '[]'))
      });
    }
  }

  // Update the Order with the remaining balance
  if (booking && booking.Order && balance > 0) {
    booking.Order.remaining_balance = balance;
    booking.Order.remaining_balance_paid = false;
    await booking.Order.save();
  }

  // Generate PDF and upload to Cloudinary
  try {
    const billableItems = items && items.length > 0 ? items.map(item => ({
      item_type: 'Item',
      description: item.description || serviceName || 'Service',
      price: parseFloat(item.rate || 0),
      qty: parseInt(item.qty || 1, 10)
    })) : [];

    if (parseFloat(invoice.additional_charges) > 0) {
      billableItems.push({
        item_type: 'Additional Charges',
        description: invoice.additional_charges_desc || 'Extra Fees',
        price: parseFloat(invoice.additional_charges),
        qty: 1
      });
    }

    const isPartner = booking?.Service?.service_owner_type === 'PARTNER';
    const subtotal = billableItems.reduce((acc, curr) => acc + (curr.price * curr.qty), 0);
    const gstAmount = isPartner ? 0 : Math.max(0, parseFloat(invoice.grand_total) - subtotal);

    const pdfInvoiceData = {
      invoice_number: invoice.invoice_number,
      order_number: invoice.order_id,
      customer: {
        name: invoice.customer_name,
        mobile: invoice.mobile,
        address: invoice.address || 'Address not provided'
      },
      items: billableItems,
      subtotal: subtotal,
      gst_percent: isPartner ? 0 : parseFloat(invoice.gst_percent || 18),
      tax_amount: gstAmount > 0.01 ? gstAmount : 0,
      total_amount: isPartner ? subtotal : parseFloat(invoice.grand_total)
    };

    const pdfBuffer = await generateInvoicePdfBuffer(pdfInvoiceData);
    const pdfUrl = await uploadPdfStreamToCloudinary(pdfBuffer, `invoice_${invoice.invoice_number}`);
    
    invoice.invoice_pdf_url = pdfUrl;
    await invoice.save();
  } catch (error) {
    console.error('Error generating/uploading PDF during invoice creation:', error);
    // We don't fail the invoice creation if PDF upload fails, but it won't have a URL.
  }

  return invoice;
};

const getPendingServiceBookings = async () => {
  // Find all COMPLETED bookings
  const bookings = await ServiceBooking.findAll({
    where: { status: 'COMPLETED' },
    include: [
      { 
        model: Service, 
        include: [{ model: require('../../models').Category, as: 'category' }] 
      },
      { model: Order, include: [{ model: Customer, as: 'customer' }] },
      { model: ExtraItemsRequest, as: 'extra_items', where: { status: 'APPROVED' }, required: false }
    ],
    order: [['createdAt', 'DESC']]
  });

  // Filter out the ones that already have an invoice
  // Since order_id in Invoice maps to display_id of booking
  const displayIds = bookings.map(b => b.display_id);
  const existingInvoices = await Invoice.findAll({
    where: { order_id: displayIds, type: 'SERVICE' },
    attributes: ['order_id']
  });
  
  const existingInvoiceIds = existingInvoices.map(i => i.order_id);
  
  const pending = bookings.filter(b => !existingInvoiceIds.includes(b.display_id));

  // Map to the format the admin frontend expects (mockSRs format)
  return pending.map(b => {
    const customer = b.Order && b.Order.customer ? b.Order.customer : {};
    return {
      id: b.id,
      srNo: b.display_id,
      customerName: customer.full_name || (b.Order && b.Order.customer_name) || 'N/A',
      mobile: customer.mobile || (b.Order && b.Order.customer_contact) || 'N/A',
      email: customer.email || '',
      address: (() => {
        let addr = b.address;
        if (typeof addr === 'string' && addr.trim().startsWith('{')) {
          try { addr = JSON.parse(addr); } catch (e) {}
        }
        if (typeof addr === 'object' && addr !== null) {
          return [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ');
        }
        return addr || '';
      })(),
      service: b.Service ? b.Service.name : 'Custom Service',
      category: (b.Service && b.Service.category) ? b.Service.category.name : 'Service',
      qty: b.quantity ? parseFloat(b.quantity) : 1,
      rate: (b.Order && b.Order.subtotal_amount && b.quantity) ? parseFloat(b.Order.subtotal_amount) / parseFloat(b.quantity) : (b.Service ? parseFloat(b.Service.prebooking_charge) : 0),
      completedOn: b.updatedAt.toDateString(),
      extraItems: b.extra_items ? b.extra_items.map((extra) => ({
        description: extra.description,
        qty: extra.qty
      })) : []
    };
  });
};

const generateServiceInvoicePdf = async (bookingId) => {
  let booking = null;
  const bookingIdStr = String(bookingId || '').trim();

  if (bookingIdStr.startsWith('BKG-') || bookingIdStr.startsWith('SR-')) {
    const rawNumber = bookingIdStr.startsWith('SR-') ? bookingIdStr.replace('SR-', '') : bookingIdStr.replace('BKG-', '');
    const autoId = parseInt(rawNumber, 10) - 1000;
    if (!isNaN(autoId)) {
      booking = await ServiceBooking.findOne({
        where: { auto_id: autoId },
        include: [
          { model: Service },
          { model: Order, include: [{ model: Customer, as: 'customer' }] },
          { model: ExtraItemsRequest, as: 'extra_items', where: { status: 'APPROVED' }, required: false }
        ]
      });
    }
  } else if (!isNaN(Number(bookingIdStr)) && bookingIdStr !== '') {
    booking = await ServiceBooking.findOne({
      where: { auto_id: Number(bookingIdStr) },
      include: [
        { model: Service },
        { model: Order, include: [{ model: Customer, as: 'customer' }] },
        { model: ExtraItemsRequest, as: 'extra_items', where: { status: 'APPROVED' }, required: false }
      ]
    });
  }

  if (!booking) {
    // Fallback to internal UUID if display_id fails
    const bookingByUuid = await ServiceBooking.findByPk(bookingIdStr, {
      include: [
        { model: Service },
        { model: Order, include: [{ model: Customer, as: 'customer' }] },
        { model: ExtraItemsRequest, as: 'extra_items', where: { status: 'APPROVED' }, required: false }
      ]
    });
    if (bookingByUuid) {
      booking = bookingByUuid;
    }
  }

  const displayId = booking ? (booking.display_id || `SR-${booking.auto_id + 1000}`) : bookingIdStr;

  let savedInvoice = await Invoice.findOne({
    where: { order_id: displayId, type: 'SERVICE' },
    include: [{ model: InvoiceItem, as: 'items' }]
  });

  if (!savedInvoice && bookingIdStr !== displayId) {
    savedInvoice = await Invoice.findOne({
      where: { order_id: bookingIdStr, type: 'SERVICE' },
      include: [{ model: InvoiceItem, as: 'items' }]
    });
  }

  if (!savedInvoice && booking && booking.auto_id) {
    // Dual prefix fallback (check alternate prefix)
    const altDisplayId = displayId.startsWith('SR-') ? `BKG-${booking.auto_id + 1000}` : `SR-${booking.auto_id + 1000}`;
    savedInvoice = await Invoice.findOne({
      where: { order_id: altDisplayId, type: 'SERVICE' },
      include: [{ model: InvoiceItem, as: 'items' }]
    });
  }

  if (!savedInvoice) {
    throw new AppError('Invoice not generated by Admin yet', 404);
  }

  // Generate the PDF buffer
  const billableItems = (savedInvoice.items || []).map(item => ({
    item_type: 'Item',
    description: item.description,
    price: parseFloat(item.rate),
    qty: item.qty
  }));

  if (parseFloat(savedInvoice.additional_charges) > 0) {
    billableItems.push({
      item_type: 'Additional Charges',
      description: savedInvoice.additional_charges_desc || 'Extra Fees',
      price: parseFloat(savedInvoice.additional_charges),
      qty: 1
    });
  }

  const isPartner = booking?.Service?.service_owner_type === 'PARTNER';

  let finalBillableItems = billableItems;
  let subtotal = billableItems.reduce((acc, curr) => acc + (curr.price * curr.qty), 0);
  let gstAmount = 0;
  let totalAmount = parseFloat(savedInvoice.grand_total);
  const gstPercent = parseFloat(savedInvoice.gst_percent || 18);

  if (isPartner) {
    // Agricultural Partner Service (SAC 9986 - 0% Exempt for Farmers)
    // Farmer pays flat price (0% GST) under Notification 12/2017 Central Tax (Rate).
    // Platform fees and commission GST are internal B2B charges documented in the separate Admin Commission Invoice.
    finalBillableItems = billableItems.map(item => ({
      ...item,
      description: item.description ? `${item.description} (SAC 9986 - Exempt)` : 'Agricultural Service (SAC 9986 - Exempt)',
      rate_incl_tax: item.price,
      rate_excl_tax: item.price,
      tax_rate: 0
    }));

    subtotal = finalBillableItems.reduce((acc, curr) => acc + (curr.price * curr.qty), 0);
    gstAmount = 0;
    totalAmount = subtotal;
  } else {
    gstAmount = Math.max(0, totalAmount - subtotal);
  }

  const invoiceData = {
    invoice_number: savedInvoice.invoice_number,
    order_number: displayId || savedInvoice.order_id,
    is_service: true,
    customer: {
      name: savedInvoice.customer_name,
      mobile: savedInvoice.mobile,
      address: savedInvoice.address || 'Address not provided'
    },
    items: finalBillableItems,
    subtotal: subtotal,
    gst_percent: isPartner ? 0 : gstPercent,
    tax_amount: gstAmount > 0.01 ? gstAmount : 0,
    total_amount: totalAmount
  };

  const pdfBuffer = await generateInvoicePdfBuffer(invoiceData);

  // If not already uploaded to Cloudinary, upload and save URL
  if (!savedInvoice.invoice_pdf_url) {
    try {
      const pdfUrl = await uploadPdfStreamToCloudinary(pdfBuffer, `invoice_${savedInvoice.invoice_number}`);
      savedInvoice.invoice_pdf_url = pdfUrl;
      await savedInvoice.save();
    } catch (err) {
      console.error('Failed to cache invoice PDF to Cloudinary:', err);
    }
  }

  return { pdfBuffer, invoice: savedInvoice };
};

const autoGenerateProductInvoice = async (orderId) => {
  const { Op } = require('sequelize');
  const order = await Order.findOne({
    where: {
      [Op.or]: [{ order_number: orderId }, { id: orderId }]
    },
    include: [
      { model: Customer, as: 'customer' },
      { 
        model: OrderItem, 
        as: 'items',
        include: [{ model: Product, as: 'product' }]
      }
    ]
  });

  if (!order) return null;

  const activeItems = (order.items || []).filter(item => item.status !== 'CANCELLED');
  const itemsToBill = activeItems.length > 0 ? activeItems : (order.items || []);

  const subtotal = itemsToBill.reduce((sum, it) => sum + parseFloat(it.subtotal || 0), 0);
  const taxAmount = (itemsToBill.length === (order.items || []).length && order.tax_amount) 
    ? parseFloat(order.tax_amount) 
    : parseFloat((subtotal * 0.18).toFixed(2));
  const grandTotal = (itemsToBill.length === (order.items || []).length && order.total_amount) 
    ? parseFloat(order.total_amount) 
    : parseFloat((subtotal + taxAmount).toFixed(2));

  let invoice = await Invoice.findOne({
    where: { order_id: order.order_number },
    include: [{ model: InvoiceItem, as: 'items' }]
  });

  if (!invoice) {
    const invoice_number = 'INV' + Date.now() + Math.floor(Math.random() * 1000);
    invoice = await Invoice.create({
      invoice_number,
      order_id: order.order_number,
      vendor_id: order.items[0]?.vendor_id || null,
      customer_name: order.customer_name || (order.customer ? order.customer.full_name : 'N/A'),
      mobile: order.customer_contact || (order.customer ? order.customer.mobile : 'N/A'),
      email: order.customer ? order.customer.email : '',
      address: order.customer_address || '',
      additional_charges: 0,
      gst_percent: 18,
      grand_total: grandTotal,
      status: 'Paid',
      type: 'VENDOR'
    });
  } else {
    invoice.grand_total = grandTotal;
    invoice.status = 'Paid';
    await invoice.save();
  }

  // Ensure all billable items are present in InvoiceItem
  const existingInvItems = await InvoiceItem.findAll({ where: { invoice_id: invoice.id } });
  for (const item of itemsToBill) {
    const prodName = item.product ? item.product.name : (item.Product ? item.Product.name : 'Product');
    const existing = existingInvItems.find(invIt => 
      invIt.description.toLowerCase().trim() === prodName.toLowerCase().trim() ||
      (parseFloat(invIt.rate) === parseFloat(item.price) && parseInt(invIt.qty, 10) === parseInt(item.qty, 10))
    );
    if (!existing) {
      const newInvItem = await InvoiceItem.create({
        invoice_id: invoice.id,
        description: prodName,
        qty: item.qty || 1,
        rate: item.price || 0,
        amount: item.subtotal || 0,
        warranty: '',
        model_number: '',
        hsn_code: '',
        serial_numbers: '[]'
      });
      existingInvItems.push(newInvItem);
    }
  }

  // Build billable items directly from order items so customer rates and totals match
  const billableItems = itemsToBill.map(item => {
    const qty = parseInt(item.qty || item.quantity || 1, 10);
    const itemSubtotal = parseFloat(item.subtotal || 0);
    const itemPrice = parseFloat(item.price || 0);
    const unitPriceExcl = parseFloat((itemSubtotal / qty).toFixed(2));
    const unitPriceIncl = parseFloat((itemPrice / qty).toFixed(2));
    return {
      item_type: 'Product',
      description: item.product ? item.product.name : (item.Product ? item.Product.name : 'Product'),
      price: unitPriceExcl,
      rate_incl_tax: unitPriceIncl,
      qty
    };
  });

  try {
    const pdfInvoiceData = {
      invoice_number: invoice.invoice_number,
      order_number: invoice.order_id,
      company_name: order.company_name,
      customer: {
        name: invoice.customer_name,
        company_name: order.company_name,
        mobile: invoice.mobile,
        address: invoice.address || 'Address not provided'
      },
      gst_number: order.gst_number,
      gst_state_code: order.gst_state_code || (order.gst_number ? order.gst_number.slice(0, 2) : (order.customer ? getGstStateCode(order.customer.state_name) : '37')),
      items: billableItems,
      subtotal: subtotal,
      gst_percent: parseFloat(invoice.gst_percent || 18),
      tax_amount: taxAmount,
      total_amount: grandTotal
    };

    const pdfBuffer = await generateInvoicePdfBuffer(pdfInvoiceData);
    const pdfUrl = await uploadPdfStreamToCloudinary(pdfBuffer, `invoice_${invoice.invoice_number}`);
    invoice.invoice_pdf_url = pdfUrl;
    await invoice.save();
  } catch (pdfErr) {
    console.error('Error auto-generating PDF for product order invoice:', pdfErr);
  }

  return invoice;
};

const generateOrderInvoicePdf = async (orderId) => {
  const orderIdStr = String(orderId || '').trim();
  const { Op } = require('sequelize');

  // 1. Try finding Order first
  const order = await Order.findOne({
    where: {
      [Op.or]: [{ order_number: orderIdStr }, { id: orderIdStr }]
    },
    include: [
      { model: Customer, as: 'customer' },
      { 
        model: OrderItem, 
        as: 'items',
        include: [{ model: Product, as: 'product' }]
      }
    ]
  });

  if (order) {
    const activeItems = (order.items || []).filter(item => item.status !== 'CANCELLED');
    const itemsToBill = activeItems.length > 0 ? activeItems : (order.items || []);

    let invoice = await Invoice.findOne({
      where: { order_id: order.order_number },
      include: [
        { model: InvoiceItem, as: 'items' },
        { model: Vendor, as: 'vendor' }
      ]
    });

    const existingItemsCount = invoice && invoice.items ? invoice.items.length : 0;
    if (!invoice || existingItemsCount < itemsToBill.length) {
      invoice = await autoGenerateProductInvoice(order.order_number);
      invoice = await Invoice.findOne({
        where: { id: invoice.id },
        include: [
          { model: InvoiceItem, as: 'items' },
          { model: Vendor, as: 'vendor' }
        ]
      });
    }

    if (invoice) {
      const billableItems = itemsToBill.map(item => {
        const qty = parseInt(item.qty || item.quantity || 1, 10);
        const itemSubtotal = parseFloat(item.subtotal || 0);
        const itemPrice = parseFloat(item.price || 0);
        const unitPriceExcl = parseFloat((itemSubtotal / qty).toFixed(2));
        const unitPriceIncl = parseFloat((itemPrice / qty).toFixed(2));
        return {
          item_type: 'Product',
          description: item.product ? item.product.name : (item.Product ? item.Product.name : 'Product'),
          price: unitPriceExcl,
          rate_incl_tax: unitPriceIncl,
          qty
        };
      });

      const subtotal = (order && order.subtotal_amount) 
        ? parseFloat(order.subtotal_amount) 
        : billableItems.reduce((acc, curr) => acc + (curr.price * curr.qty), 0);
      const grandTotal = (order && order.total_amount) 
        ? parseFloat(order.total_amount) 
        : parseFloat(invoice.grand_total);
      const gstAmount = (order && order.tax_amount) 
        ? parseFloat(order.tax_amount) 
        : (grandTotal - subtotal > 0 ? parseFloat((grandTotal - subtotal).toFixed(2)) : 0);

      const invoiceData = {
        invoice_number: invoice.invoice_number,
        order_number: order.order_number || invoice.order_id || orderIdStr,
        company_name: order.company_name || invoice.company_name,
        customer: {
          name: invoice.customer_name || order.customer_name || (order.customer ? order.customer.full_name : 'Customer'),
          company_name: order.company_name || invoice.company_name,
          mobile: invoice.mobile || order.customer_contact || (order.customer ? order.customer.mobile : 'N/A'),
          address: invoice.address || order.customer_address || 'Address not provided'
        },
        gst_number: order.gst_number,
        gst_state_code: order.gst_state_code || (order.gst_number ? order.gst_number.slice(0, 2) : (order.customer ? getGstStateCode(order.customer.state_name) : '37')),
        items: billableItems,
        subtotal: subtotal,
        gst_percent: parseFloat(invoice.gst_percent || 18),
        tax_amount: gstAmount > 0.01 ? gstAmount : 0,
        total_amount: grandTotal
      };

      const pdfBuffer = await generateInvoicePdfBuffer(invoiceData);

      try {
        const pdfUrl = await uploadPdfStreamToCloudinary(pdfBuffer, `invoice_${invoice.invoice_number}`);
        invoice.invoice_pdf_url = pdfUrl;
        await invoice.save();
      } catch (err) {
        console.error('Failed to cache order invoice PDF to Cloudinary:', err);
      }

      return { pdfBuffer, invoice };
    }
  }

  // 2. Direct invoice number fallback
  let invoice = await Invoice.findOne({
    where: { invoice_number: orderIdStr },
    include: [
      { model: InvoiceItem, as: 'items' },
      { model: Vendor, as: 'vendor' }
    ]
  });

  if (!invoice) {
    throw new AppError('Invoice not found for this order', 404);
  }

  const billableItems = (invoice.items || []).map(item => ({
    item_type: 'Product',
    description: item.description,
    price: parseFloat(item.rate),
    qty: item.qty
  }));

  const subtotal = billableItems.reduce((acc, curr) => acc + (curr.price * curr.qty), 0);
  const gstAmount = parseFloat(invoice.grand_total) - subtotal;

  const invoiceData = {
    invoice_number: invoice.invoice_number,
    order_number: invoice.order_id || orderIdStr,
    customer: {
      name: invoice.customer_name,
      mobile: invoice.mobile,
      address: invoice.address || 'Address not provided'
    },
    items: billableItems,
    subtotal: subtotal,
    gst_percent: parseFloat(invoice.gst_percent || 18),
    tax_amount: gstAmount > 0.01 ? gstAmount : 0,
    total_amount: parseFloat(invoice.grand_total)
  };

  const pdfBuffer = await generateInvoicePdfBuffer(invoiceData);
  return { pdfBuffer, invoice };
};

const getVendorInvoices = async (vendor_id) => {
  const invoices = await Invoice.findAll({
    where: { vendor_id, type: 'VENDOR' },
    include: [
      { model: InvoiceItem, as: 'items' },
      { model: Vendor, as: 'vendor', attributes: ['id', 'business_name', 'full_name', 'gst_number', 'gst_state_code', 'mobile', 'email', 'address'] }
    ],
    order: [['createdAt', 'DESC']]
  });
  return invoices;
};


const generatePartnerCommissionInvoicePdf = async (bookingId) => {
  const bookingIdStr = String(bookingId || '').trim();
  const { Partner } = require('../../models');

  let booking = null;
  if (bookingIdStr.startsWith('BKG-') || bookingIdStr.startsWith('SR-')) {
    const rawNumber = bookingIdStr.startsWith('SR-') ? bookingIdStr.replace('SR-', '') : bookingIdStr.replace('BKG-', '');
    const autoId = parseInt(rawNumber, 10) - 1000;
    if (!isNaN(autoId)) {
      booking = await ServiceBooking.findOne({
        where: { auto_id: autoId },
        include: [
          { model: Service, as: 'Service' },
          { model: Order, as: 'Order' },
          { model: Partner, as: 'assigned_partner' }
        ]
      });
    }
  } else if (!isNaN(Number(bookingIdStr)) && bookingIdStr !== '') {
    booking = await ServiceBooking.findOne({
      where: { auto_id: Number(bookingIdStr) },
      include: [
        { model: Service, as: 'Service' },
        { model: Order, as: 'Order' },
        { model: Partner, as: 'assigned_partner' }
      ]
    });
  }

  if (!booking) {
    booking = await ServiceBooking.findByPk(bookingIdStr, {
      include: [
        { model: Service, as: 'Service' },
        { model: Order, as: 'Order' },
        { model: Partner, as: 'assigned_partner' }
      ]
    });
  }

  if (!booking) {
    throw new AppError('Service booking not found', 404);
  }

  const displayId = booking.display_id || `SR-${booking.auto_id + 1000}`;
  const partner = booking.assigned_partner;
  const isPartner = (booking.Service?.service_owner_type === 'PARTNER') || (booking.metadata?.service_owner_type === 'PARTNER');

  if (!isPartner) {
    throw new AppError('Commission invoice is only applicable for Partner services', 400);
  }

  const commRate = parseFloat(booking.metadata?.admin_commission_rate ?? booking.Service?.admin_commission_rate ?? 10);
  const totalBookingAmount = booking.Order?.total_amount ? parseFloat(booking.Order.total_amount) : (parseFloat(booking.Service?.price || 0) * (booking.quantity || 1));
  const grossComm = booking.metadata?.admin_commission_amount ? parseFloat(booking.metadata.admin_commission_amount) : Math.round(totalBookingAmount * (commRate / 100) * 100) / 100;

  const platformFeeTaxable = booking.metadata?.platform_fee_taxable ? parseFloat(booking.metadata.platform_fee_taxable) : Math.round((grossComm / 1.18) * 100) / 100;
  const platformFeeGst = booking.metadata?.platform_fee_gst ? parseFloat(booking.metadata.platform_fee_gst) : Math.round((grossComm - platformFeeTaxable) * 100) / 100;
  const partnerPayout = booking.metadata?.partner_payout_amount ? parseFloat(booking.metadata.partner_payout_amount) : Math.round((totalBookingAmount - grossComm) * 100) / 100;

  const invoiceNumber = `COMM-${displayId.replace(/[^A-Za-z0-9]/g, '')}`;

  const commissionInvoiceData = {
    invoice_title: 'Commission Tax Invoice (B2B)',
    invoice_number: invoiceNumber,
    order_number: displayId,
    is_service: true,
    customer: {
      name: partner ? `${partner.full_name} (Service Partner)` : 'Service Partner',
      mobile: partner?.mobile || 'N/A',
      address: partner?.address || 'Partner Service Location'
    },
    items: [
      {
        item_type: 'Platform Fee',
        description: `Marketplace Platform Commission (${commRate}% Facilitation Fee on ${displayId}) (SAC 996111)`,
        qty: 1,
        price: platformFeeTaxable,
        rate_incl_tax: grossComm,
        tax_rate: 18
      }
    ],
    subtotal: platformFeeTaxable,
    gst_percent: 18,
    tax_amount: platformFeeGst,
    total_amount: grossComm
  };

  const pdfBuffer = await generateInvoicePdfBuffer(commissionInvoiceData);
  return { pdfBuffer, invoiceNumber, displayId, grossComm, platformFeeTaxable, platformFeeGst, partnerPayout };
};

module.exports = {
  deleteAdminInvoice,
  createVendorInvoice,
  getAdminInvoices,
  generateServiceInvoicePdf,
  generatePartnerCommissionInvoicePdf,
  createServiceInvoice,
  getPendingServiceBookings,
  getVendorInvoices,
  autoGenerateProductInvoice,
  generateOrderInvoicePdf
};
