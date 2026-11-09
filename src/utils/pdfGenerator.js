const PDFDocument = require('pdfkit');
const { isSameStateAsCompany, getGstStateCode } = require('./gstStateCodes');

function buildInvoicePdf(invoiceData, dataCallback, endCallback) {
  const doc = new PDFDocument({ margin: 50 });

  doc.on('data', dataCallback);
  doc.on('end', endCallback);

  generateHeader(doc);
  const customerBottomY = generateCustomerInformation(doc, invoiceData);
  const tableTop = Math.max(310, (customerBottomY || 260) + 25);
  const tableBottomY = generateInvoiceTable(doc, invoiceData, tableTop);
  if (!invoiceData.is_service) {
    generateWarrantyConditions(doc, tableBottomY);
  }
  generateFooter(doc);

  doc.end();
}

function generateHeader(doc) {
  doc
    .fillColor('#444444')
    .fontSize(20)
    .text('Assure Technologies', 50, 57)
    .fontSize(9)
    .font('Helvetica')
    .text('1st Floor, 5-15 Shop No 1, Dandu Venkata Ramaiah Commercial', 180, 55, { align: 'right' })
    .text('A Konduru, NTR District, Andhra Pradesh - 521227', 180, 70, { align: 'right' })
    .font('Helvetica-Bold')
    .text('GSTIN: 37DJPPN2516B1Z9', 180, 85, { align: 'right' })
    .font('Helvetica')
    .moveDown();
}

function formatInvoiceAddressLines(rawAddress) {
  if (!rawAddress || rawAddress === 'Address not provided' || rawAddress === 'N/A') {
    return ['Address not provided'];
  }

  if (typeof rawAddress === 'string' && rawAddress.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(rawAddress);
      const line1 = [parsed.line1 || parsed.addressLine1, parsed.line2 || parsed.addressLine2, parsed.landmark].map(s => s && String(s).trim()).filter(Boolean).join(', ');
      const line2Parts = [parsed.city, parsed.state].map(s => s && String(s).trim()).filter(Boolean);
      const pin = parsed.pincode || parsed.postalCode || parsed.pin;
      const line2 = line2Parts.join(', ') + (pin ? ` - ${pin}` : '');
      return [line1, line2].filter(Boolean);
    } catch (e) {}
  }

  const rawParts = String(rawAddress)
    .replace(/\r\n/g, '\n')
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (rawParts.length === 0) {
    return ['Address not provided'];
  }

  const fullText = rawParts.join(', ');
  const pinMatches = fullText.match(/\b(\d{6})\b/g);
  const pincode = pinMatches ? pinMatches[pinMatches.length - 1] : null;

  const cleanParts = rawParts
    .map(p => p.replace(/[-–—]?\s*\b\d{6}\b/g, '').trim())
    .filter(Boolean);

  if (cleanParts.length === 0) {
    return [pincode ? `PIN: ${pincode}` : fullText];
  }

  if (cleanParts.length === 1) {
    return [cleanParts[0] + (pincode ? ` - ${pincode}` : '')];
  }

  if (cleanParts.length === 2) {
    return [
      cleanParts[0],
      cleanParts[1] + (pincode ? ` - ${pincode}` : '')
    ];
  }

  const street = cleanParts.slice(0, -2).join(', ');
  const cityState = cleanParts.slice(-2).join(', ') + (pincode ? ` - ${pincode}` : '');

  return [street, cityState].filter(Boolean);
}

function generateCustomerInformation(doc, invoiceData) {
  const customer = invoiceData.customer || {};
  
  const invoiceTitle = invoiceData.invoice_title || 'Invoice';
  doc
    .fillColor('#444444')
    .fontSize(20)
    .text(invoiceTitle, 50, 160);

  generateHr(doc, 185);

  const customerInformationTop = 200;
  let infoY = customerInformationTop;

  const orderNum = invoiceData.order_number;
  if (orderNum) {
    const isService = invoiceData.is_service || String(orderNum).startsWith('SR-') || String(orderNum).startsWith('BKG-');
    const orderLabel = isService ? 'SR Number:' : 'Order Number:';
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(orderLabel, 50, infoY)
      .font('Helvetica-Bold')
      .text(String(orderNum), 150, infoY);
    infoY += 15;
  }

  doc
    .fontSize(10)
    .font('Helvetica')
    .text('Invoice Number:', 50, infoY)
    .font('Helvetica-Bold')
    .text(invoiceData.invoice_number || 'N/A', 150, infoY)
    .font('Helvetica')
    .text('Invoice Date:', 50, infoY + 15)
    .text(new Date().toLocaleDateString(), 150, infoY + 15);
    
  const billToX = 300;
  const billToWidth = 240;

  doc
    .font('Helvetica')
    .text('Bill To:', billToX, customerInformationTop);

  let currentY = customerInformationTop + 15;

  const companyName = invoiceData.company_name || customer.company_name;
  if (companyName) {
    doc.font('Helvetica-Bold').text(companyName, billToX, currentY, { width: billToWidth });
    currentY += doc.heightOfString(companyName, { width: billToWidth }) + 4;
    if (customer.name) {
      doc.font('Helvetica').text(`Contact: ${customer.name}`, billToX, currentY, { width: billToWidth });
      currentY += doc.heightOfString(`Contact: ${customer.name}`, { width: billToWidth }) + 4;
    }
  } else if (customer.name) {
    doc.font('Helvetica-Bold').text(customer.name, billToX, currentY, { width: billToWidth });
    currentY += doc.heightOfString(customer.name, { width: billToWidth }) + 4;
  }

  const addressLines = formatInvoiceAddressLines(customer.address);
  doc.font('Helvetica');
  for (const line of addressLines) {
    doc.text(line, billToX, currentY, { width: billToWidth });
    currentY += doc.heightOfString(line, { width: billToWidth }) + 3;
  }
  currentY += 1;

  if (customer.mobile) {
    doc.text(customer.mobile, billToX, currentY, { width: billToWidth });
    currentY += doc.heightOfString(customer.mobile, { width: billToWidth }) + 4;
  }

  const customerGstin = invoiceData.gst_number || customer.gst_number || customer.gstin;
  if (customerGstin) {
    const gstinText = `GSTIN: ${customerGstin}`;
    doc.text(gstinText, billToX, currentY, { width: billToWidth });
    currentY += doc.heightOfString(gstinText, { width: billToWidth }) + 4;
  }

  const customerStateCode = invoiceData.gst_state_code || customer.gst_state_code || getGstStateCode(customer.address || customer.state);
  if (customerStateCode) {
    const stateCodeText = `State Code: ${customerStateCode}`;
    doc.text(stateCodeText, billToX, currentY, { width: billToWidth });
    currentY += doc.heightOfString(stateCodeText, { width: billToWidth }) + 4;
  }

  const hrY = Math.max(260, Math.max(currentY, infoY + 25) + 10);
  generateHr(doc, hrY);

  return hrY;
}

function generateInvoiceTable(doc, invoiceData, startTop = 330) {
  let i;
  const invoiceTableTop = startTop;

  doc.font('Helvetica-Bold');
  generateTableRow(
    doc,
    invoiceTableTop,
    'Description',
    'Qty',
    'Rate (Incl. Tax)',
    'Rate (Excl. Tax)',
    'Amount'
  );
  generateHr(doc, invoiceTableTop + 20);
  doc.font('Helvetica');

  // Filter out any tax items from table rows so tax has no quantity column
  const allItems = invoiceData.items || [];
  const taxItem = allItems.find(item => item.item_type === 'Tax');
  const items = allItems.filter(item => item.item_type !== 'Tax');

  const gstPercent = invoiceData.gst_percent !== undefined
    ? parseFloat(invoiceData.gst_percent)
    : 18;

  let position = invoiceTableTop;
  for (i = 0; i < items.length; i++) {
    const item = items[i];
    position = invoiceTableTop + 30 + (i * 26);
    const qty = item.qty != null ? item.qty : 1;
    const rateExcl = item.price != null ? item.price : 0;
    const rateIncl = item.rate_incl_tax != null 
      ? item.rate_incl_tax 
      : (rateExcl * (1 + (gstPercent / 100)));
    const lineTotal = rateExcl * qty;

    generateTableRow(
      doc,
      position,
      item.description || item.item_type || 'Item',
      String(qty),
      formatCurrency(rateIncl),
      formatCurrency(rateExcl),
      formatCurrency(lineTotal)
    );

    generateHr(doc, position + 18);
  }

  const subtotal = invoiceData.subtotal !== undefined
    ? parseFloat(invoiceData.subtotal)
    : items.reduce((acc, curr) => acc + (parseFloat(curr.price || 0) * parseInt(curr.qty || 1, 10)), 0);

  const taxAmount = invoiceData.tax_amount !== undefined
    ? parseFloat(invoiceData.tax_amount)
    : (taxItem ? parseFloat(taxItem.price || 0) : Math.max(0, parseFloat(invoiceData.total_amount || 0) - subtotal));

  const totalAmount = invoiceData.total_amount !== undefined
    ? parseFloat(invoiceData.total_amount)
    : (subtotal + taxAmount);

  let summaryY = (items.length > 0 ? position : invoiceTableTop) + 35;

  // 1. Subtotal (Taxable Amount)
  doc.font('Helvetica-Bold');
  generateSummaryRow(
    doc,
    summaryY,
    'Subtotal (Taxable):',
    formatCurrency(subtotal)
  );

  // 2. GST Breakdown (CGST + SGST for Intra-State, IGST for Inter-State)
  if (taxAmount > 0.001) {
    const stateCode = invoiceData.gst_state_code || invoiceData.customer?.gst_state_code || getGstStateCode(invoiceData.customer?.address || invoiceData.customer?.state);
    const isSameState = isSameStateAsCompany(stateCode);

    doc.font('Helvetica');
    if (isSameState) {
      const halfTax = taxAmount / 2;
      summaryY += 20;
      generateSummaryRow(
        doc,
        summaryY,
        `CGST (${(gstPercent / 2).toFixed(1)}%):`,
        formatCurrency(halfTax)
      );
      summaryY += 20;
      generateSummaryRow(
        doc,
        summaryY,
        `SGST (${(gstPercent / 2).toFixed(1)}%):`,
        formatCurrency(halfTax)
      );
    } else {
      summaryY += 20;
      generateSummaryRow(
        doc,
        summaryY,
        `IGST (${gstPercent}%):`,
        formatCurrency(taxAmount)
      );
    }
  }

  // 3. Grand Total
  summaryY += 25;
  generateHr(doc, summaryY - 5);
  doc.font('Helvetica-Bold');
  generateSummaryRow(
    doc,
    summaryY,
    'Total Amount:',
    formatCurrency(totalAmount)
  );

  return summaryY + 25;
}

function generateWarrantyConditions(doc, startY) {
  let y = startY || 450;
  if (y > 480) {
    doc.addPage();
    y = 50;
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#0f172a')
    .text('Component Warranty Conditions', 50, y);

  y += 15;
  doc
    .strokeColor('#cbd5e1')
    .lineWidth(0.8)
    .moveTo(50, y)
    .lineTo(550, y)
    .stroke();

  y += 10;

  const bulletItems = [
    {
      title: 'Manufacturer Warranty: ',
      text: 'Hardware components (cameras, NVRs/DVRs, hard drives) carry a 1-to-3-year manufacturer warranty from the date of purchase. The installer acts as the facilitator for these claims.'
    },
    {
      title: 'Workmanship/Labor Warranty: ',
      text: 'Installation labor is typically covered for 90 days to 1 year. This covers faulty wiring, loose mounts, or incorrect configuration by the technicians.'
    },
    {
      title: 'Warranty Exclusions: ',
      text: 'The warranty is strictly void under the following conditions:',
      subBullets: [
        'Damage caused by lightning strikes, power surges, floods, or acts of God.',
        'Vandalism, physical tampering, or unauthorized relocation of cameras.',
        'Modifications to software settings, network routing, or firmware updates done by the client or a third party.'
      ]
    },
    {
      title: 'Consumables Exclusion: ',
      text: 'Cables, connectors, power adapters, and batteries are generally excluded from long-term warranties or carry a heavily reduced coverage period (e.g., 90 days).'
    },
    {
      title: 'Advance Replacement Policy: ',
      text: 'Defective components must be tested and verified before a replacement is issued. Loaner cameras during the manufacturer repair window are not included unless a separate Annual Maintenance Contract (AMC) is signed.'
    }
  ];

  for (const item of bulletItems) {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }

    doc
      .fontSize(8.5)
      .fillColor('#334155')
      .font('Helvetica')
      .text('•', 50, y, { width: 10 });

    doc
      .fontSize(8.5)
      .fillColor('#0f172a')
      .font('Helvetica-Bold')
      .text(item.title, 64, y, { continued: true, width: 486 })
      .fillColor('#334155')
      .font('Helvetica')
      .text(item.text, { width: 486 });

    y = doc.y + 6;

    if (item.subBullets && item.subBullets.length > 0) {
      for (const sub of item.subBullets) {
        if (y > 700) {
          doc.addPage();
          y = 50;
        }
        doc
          .circle(76, y + 4.5, 1.5)
          .strokeColor('#64748b')
          .lineWidth(0.8)
          .stroke();

        doc
          .fontSize(8.5)
          .fillColor('#475569')
          .font('Helvetica')
          .text(sub, 86, y, { width: 464 });

        y = doc.y + 4;
      }
      y += 2;
    }
  }

  return y;
}

function generateFooter(doc) {
  const pageBottom = doc.page.height - 50;
  let footerY = pageBottom;

  if (doc.y + 20 > pageBottom) {
    doc.addPage();
    footerY = doc.page.height - 50;
  }

  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#666666')
    .text(
      'Thank you for your business.',
      50,
      footerY,
      { align: 'center', width: 500 }
    );
}

function generateTableRow(doc, y, description, quantity, rateInclTax, rateExclTax, lineTotal) {
  doc
    .fontSize(9)
    .text(description, 50, y, { width: 175 })
    .text(quantity, 230, y, { width: 35, align: 'center' })
    .text(rateInclTax, 270, y, { width: 85, align: 'right' })
    .text(rateExclTax, 365, y, { width: 85, align: 'right' })
    .text(lineTotal, 460, y, { width: 90, align: 'right' });
}

function generateSummaryRow(doc, y, label, value) {
  doc
    .fontSize(9)
    .text(label, 270, y, { width: 180, align: 'right' })
    .text(value, 460, y, { width: 90, align: 'right' });
}

function generateHr(doc, y) {
  doc
    .strokeColor('#aaaaaa')
    .lineWidth(1)
    .moveTo(50, y)
    .lineTo(550, y)
    .stroke();
}

function formatCurrency(amount) {
  return 'Rs. ' + Number(amount).toFixed(2);
}

function generateInvoicePdfBuffer(invoiceData) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      buildInvoicePdf(
        invoiceData,
        (chunk) => chunks.push(chunk),
        () => resolve(Buffer.concat(chunks))
      );
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  buildInvoicePdf,
  generateInvoicePdfBuffer
};
