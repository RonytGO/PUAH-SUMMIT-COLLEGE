const express = require("express");

const app = express();
app.use(express.json());

/* ---------------- HELPERS ---------------- */

function assertEnv() {
  if (!process.env.SUMMIT_COMPANY_ID || !process.env.SUMMIT_API_KEY) {
    throw new Error("Missing Summit credentials in env variables");
  }
}

function credentials() {
  return {
    CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
    APIKey: process.env.SUMMIT_API_KEY
  };
}

function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function normalizeAmount(rawAmount) {
  const cleaned = required(rawAmount, "amount").replace(/[^\d.]/g, "");
  const amount = Number(cleaned);

  if (!amount || isNaN(amount) || amount <= 0) {
    throw new Error("amount is invalid");
  }

  return amount;
}

function normalizePayments(rawPayments) {
  const payments = Number(rawPayments);
  if (!payments || isNaN(payments) || payments < 1) return 1;
  return payments;
}

function normalizePaymentMethod(method) {
  const m = required(method, "paymentmethod");

  if (m === "כרטיס אשראי") return "credit";
  if (m === "מזומן") return "cash";
  if (m === "העברה בנקאית") return "bank";

  throw new Error("Unsupported payment method");
}

/* ---------------- SUMMIT ---------------- */

function unwrapSummit(response) {
  if (!response || response.Status === undefined) {
    throw new Error("Invalid response from Summit");
  }

  if (response.Status !== 0) {
    throw new Error(
      response.UserErrorMessage ||
      response.TechnicalErrorDetails ||
      "Summit returned an error"
    );
  }

  return response.Data || {};
}

async function summitPost(endpoint, payload, label) {
  assertEnv();

  const res = await fetch(`https://app.sumit.co.il${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, Credentials: credentials() })
  });

  const text = await res.text();
  console.log(`SUMMIT ${label} RESPONSE:`, text);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} failed: ${text}`);
  }

  return unwrapSummit(parsed);
}

/* ---------------- CUSTOMER UPSERT ---------------- */

function customerDetails(customer) {
  const details = {
    ExternalIdentifier: customer.id,
    Name: customer.name
  };

  if (customer.phone) details.Phone = customer.phone;
  if (customer.email) details.EmailAddress = customer.email;
  if (customer.city) details.City = customer.city;
  if (customer.address) details.Address = customer.address;

  return details;
}

async function ensureCustomer(customer) {
  const details = customerDetails(customer);

  try {
    await summitPost(
      "/accounting/customers/update/",
      { Details: { ...details, SearchMode: 2 } },
      "CUSTOMER UPDATE"
    );
  } catch (err) {
    console.log("Update failed, trying create:", err.message);
    await summitPost(
      "/accounting/customers/create/",
      { Details: details },
      "CUSTOMER CREATE"
    );
  }
}

/* ---------------- DOCUMENT CREATION ---------------- */

function buildPayment({ amount, paymentMethod, last4, payments, bankNumber, branchNumber, accountNumber }) {
  if (paymentMethod === "cash") {
    return { Amount: amount, Type: 2 };
  }

  if (paymentMethod === "credit") {
    return {
      Amount: amount,
      Type: 5,
      Details_CreditCard: {
        Last4Digits: last4 ? String(last4) : null,
        Payments: normalizePayments(payments)
      }
    };
  }

  return {
    Amount: amount,
    Type: 3,
    Details_BankTransfer: {
      BankNumber: bankNumber ? Number(bankNumber) : null,
      BranchNumber: branchNumber ? Number(branchNumber) : null,
      AccountNumber: accountNumber ? String(accountNumber) : null
    }
  };
}

async function createInvoiceAndReceipt({ customer, amount, course, paymentId, payment }) {
  const details = {
    Type: 1,
    Date: new Date().toISOString(),
    Original: true,
    IsDraft: false,
    Customer: {
      ExternalIdentifier: customer.id,
      SearchMode: 2
    },
    ExternalReference: paymentId,
    ClosingText: 'לכל שאלה / בירור, ניתן לפנות אלינו בדוא"ל לכתובת: hd@puah.org.il'
  };

  if (customer.email) {
    details.SendByEmail = {
      EmailAddress: customer.email,
      Original: true,
      SendAsPaymentRequest: false
    };
  }

  const summit = await summitPost(
    "/accounting/documents/create/",
    {
      Details: details,
      Items: [
        {
          Quantity: 1,
          UnitPrice: amount,
          TotalPrice: amount,
          Item: { Name: course }
        }
      ],
      Payments: [payment],
      VATIncluded: true
    },
    "DOCUMENT CREATE"
  );

  if (!summit.DocumentID) {
    throw new Error("Failed to create document");
  }

  return summit;
}

/* ---------------- ROUTE ---------------- */

app.get("/summit-from-sf", async (req, res) => {
  try {
    const q = req.query;

    const paymentId = required(q.paymentId, "paymentId");
    const amount = normalizeAmount(q.amount);
    const course = required(q.course, "course");

    const customer = {
      id: required(q.customerid, "customerid"),
      name: required(q.customername, "customername"),
      phone: q.customerphone,
      email: q.customeremail,
      city: q.city,
      address: q.address
    };

    const payment = buildPayment({
      amount,
      paymentMethod: normalizePaymentMethod(q.paymentmethod),
      last4: q.last4,
      payments: q.payments,
      bankNumber: q.banknumber,
      branchNumber: q.branchnumber,
      accountNumber: q.accountnumber
    });

    await ensureCustomer(customer);

    const document = await createInvoiceAndReceipt({
      customer,
      amount,
      course,
      paymentId,
      payment
    });

    res.redirect(
      `https://puah.lightning.force.com/flow/SaveReceipt` +
      `?recordId=${encodeURIComponent(paymentId)}` +
      `&receiptUrl=${encodeURIComponent(document.DocumentDownloadURL)}`
    );

  } catch (err) {
    console.error("SF GET Summit error:", err.message);
    res.status(500).send(err.message);
  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
