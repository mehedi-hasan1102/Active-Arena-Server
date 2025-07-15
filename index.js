

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");

const app = express();
const port = process.env.PORT || 5000;

// Stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

// Stripe webhook endpoint - Must be before express.json()
// Use express.raw for verifying the webhook signature
app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Stripe webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      console.log("✅ PaymentIntent was successful!", paymentIntent.id);

      try {
        const { bookingId } = paymentIntent.metadata;
        if (!bookingId) {
          throw new Error("Booking ID missing in payment intent metadata");
        }

        // 1. Update booking status to 'confirmed'
        await bookingsCol.updateOne(
          { _id: new ObjectId(bookingId) },
          { $set: { paymentStatus: "completed", status: "Confirmed" } }
        );

        // 2. Create a new payment record
        const newPayment = {
          bookingId: new ObjectId(bookingId),
          transactionId: paymentIntent.id,
          amount: paymentIntent.amount / 100, // amount is in cents
          currency: paymentIntent.currency,
          status: paymentIntent.status,
          createdAt: new Date(),
        };
        await paymentsCol.insertOne(newPayment);

        console.log(`✅ Successfully processed payment for booking ${bookingId}`);
      } catch (dbError) {
        console.error("❌ Database update error after payment:", dbError);
        // If the DB update fails, you might need manual intervention.
        // For now, we'll return a 500 to Stripe to signal a problem.
        return res.status(500).json({ received: false, error: dbError.message });
      }
    } else {
      console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event
    res.json({ received: true });
  }
);

app.use(express.json());

// MongoDB URI and Client
const uri = `mongodb+srv://${process.env.NAME}:${process.env.PASS}@cluster0.onrfrlh.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db,
  courtsCol,
  bookingsCol,
  usersCol,
  couponsCol,
  announcementsCol,
  paymentsCol;

// Connect to MongoDB
async function connectDB() {
  try {
    await client.connect();
    db = client.db("sportsdb");
    courtsCol = db.collection("courts");
    bookingsCol = db.collection("bookings");
    usersCol = db.collection("users");
    couponsCol = db.collection("coupons");
    announcementsCol = db.collection("announcements");
    paymentsCol = db.collection("payments"); // New collection for payments
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}
connectDB();

// ========== PAYMENT ROUTES ==========

// POST validate coupon
app.post("/validate-coupon", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).send({ error: "Coupon code is required" });
    }

    const coupon = await couponsCol.findOne({
      code,
      status: "active",
    });

    if (!coupon) {
      return res.status(404).send({ error: "Invalid or expired coupon code" });
    }

    res.send({
      message: "Coupon applied successfully",
      discount: coupon.discount,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to validate coupon" });
  }
});

// POST create payment intent
app.post("/create-payment-intent", async (req, res) => {
  try {
    const { price, bookingId } = req.body;
    const amount = Math.round(parseFloat(price) * 100); // Stripe expects amount in cents

    if (!amount || amount < 50) {
      return res
        .status(400)
        .send({ error: "Invalid price amount. Must be at least $0.50." });
    }
    if (!bookingId) {
      return res.status(400).send({ error: "Booking ID is required" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: "usd",
      payment_method_types: ["card"],
      metadata: {
        bookingId: bookingId.toString(), // Add bookingId to metadata
      },
    });

    res.send({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (err) {
    console.error("Stripe Error:", err);
    res.status(500).send({ error: "Failed to create payment intent" });
  }
});

// ========== COURT ROUTES ==========

// GET all courts
app.get("/courts", async (req, res) => {
  try {
    const courts = await courtsCol.find().toArray();
    res.send({ courts });
  } catch {
    res.status(500).send({ error: "Failed to fetch courts" });
  }
});

// POST new court
app.post("/courts", async (req, res) => {
  try {
    const { name, type, status, price, image, availableSlots } = req.body;

    if (!name || !type || !price || !image || !availableSlots) {
      return res.status(400).send({ error: "All fields required" });
    }

    const newCourt = {
      name,
      type,
      status: status || "Available",
      price: parseFloat(price),
      image,
      availableSlots: Array.isArray(availableSlots)
        ? availableSlots
        : availableSlots.split(",").map((slot) => slot.trim()),
    };

    const result = await courtsCol.insertOne(newCourt);
    res.status(201).send({ message: "Court added", id: result.insertedId });
  } catch {
    res.status(500).send({ error: "Failed to add court" });
  }
});

// PUT update court
app.put("/courts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, status, price, image, availableSlots } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (type) updateData.type = type;
    if (status) updateData.status = status;
    if (price) updateData.price = parseFloat(price);
    if (image) updateData.image = image;
    if (availableSlots) {
      updateData.availableSlots = Array.isArray(availableSlots)
        ? availableSlots
        : availableSlots.split(",").map((s) => s.trim());
    }

    const result = await courtsCol.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0)
      return res.status(404).send({ error: "Court not found" });

    res.send({ message: "Court updated", modifiedCount: result.modifiedCount });
  } catch {
    res.status(500).send({ error: "Failed to update court" });
  }
});

// DELETE a court
app.delete("/courts/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await courtsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0)
      return res.status(404).send({ error: "Court not found" });

    res.send({ message: "Court deleted", deletedCount: result.deletedCount });
  } catch {
    res.status(500).send({ error: "Failed to delete court" });
  }
});

// ========== BOOKINGS ROUTES ==========

// GET all bookings with user and court details
app.get("/bookings", async (req, res) => {
  try {
    const { status, paymentStatus, courtName } = req.query;
    const query = {};
    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;

    const pipeline = [
      { $match: query },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userDetails",
        },
      },
      {
        $lookup: {
          from: "courts",
          localField: "courtId",
          foreignField: "_id",
          as: "courtDetails",
        },
      },
      {
        $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true },
      },
      {
        $unwind: { path: "$courtDetails", preserveNullAndEmptyArrays: true },
      },
      {
        $match: courtName
          ? { "courtDetails.name": { $regex: courtName, $options: "i" } }
          : {},
      },
      {
        $project: {
          _id: 1,
          userId: 1,
          userEmail: 1,
          userName: "$userDetails.name",
          courtId: 1,
          courtName: "$courtDetails.name",
          date: 1,
          slots: 1,
          price: 1,
          status: 1,
          paymentStatus: 1,
          createdAt: 1,
        },
      },
    ];

    const bookings = await bookingsCol.aggregate(pipeline).toArray();
    res.send({ bookings });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to fetch bookings" });
  }
});

// POST a new booking
app.post("/bookings", async (req, res) => {
  try {
    const { courtId, userId, userEmail, slots, date, price } = req.body;

    if (
      !courtId ||
      !userId ||
      !userEmail ||
      !slots ||
      !Array.isArray(slots) ||
      slots.length === 0 ||
      !date ||
      !price
    ) {
      return res
        .status(400)
        .send({ error: "All fields required and slots must be a non-empty array" });
    }

    const newBooking = {
      courtId: new ObjectId(courtId),
      userId,
      userEmail,
      slots,
      date: new Date(date),
      price: parseFloat(price),
      status: "pending",
      paymentStatus: "pending",
      createdAt: new Date(),
    };

    const result = await bookingsCol.insertOne(newBooking);
    res.status(201).send({ message: "Booking created", bookingId: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to create booking" });
  }
});

// PUT update booking status AND promote user to 'member'
app.put("/bookings/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userEmail, userId } = req.body;

    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).send({ error: "Invalid status" });
    }

    const booking = await bookingsCol.findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).send({ error: "Booking not found" });

    await bookingsCol.updateOne({ _id: new ObjectId(id) }, { $set: { status } });

    // Determine email for updating user role
    let emailToUpdate = userEmail || booking.userEmail;

    // If no email yet, try fetching from users collection by userId
    if (!emailToUpdate && userId) {
      const user = await usersCol.findOne({ _id: new ObjectId(userId) });
      if (user) emailToUpdate = user.email;
    }

    if (status === "Approved" && emailToUpdate) {
      await usersCol.updateOne(
        { email: emailToUpdate },
        { $set: { role: "member" } }
      );
    }

    res.send({ message: "Booking status updated" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to update booking status" });
  }
});

// PUT update booking payment status
app.put("/bookings/:id/payment", async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentStatus } = req.body;

    if (!["pending", "completed"].includes(paymentStatus)) {
      return res.status(400).send({ error: "Invalid payment status" });
    }

    const booking = await bookingsCol.findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).send({ error: "Booking not found" });

    await bookingsCol.updateOne(
      { _id: new ObjectId(id) },
      { $set: { paymentStatus } }
    );

    res.send({ message: "Booking payment status updated" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to update booking payment status" });
  }
});

// ========== USER ROUTES ==========

// GET all users
app.get("/users", async (req, res) => {
  try {
    const users = await usersCol.find().toArray();
    res.send({ users });
  } catch {
    res.status(500).send({ error: "Failed to get users" });
  }
});

// POST new user with default role 'user'
app.post("/users", async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).send({ error: "Name and email required" });
    }

    const existing = await usersCol.findOne({ email });
    if (existing) {
      return res.status(200).send({ message: "User already exists", user: existing });
    }

    const result = await usersCol.insertOne({ name, email, role: "user" });
    res.status(201).send({ message: "User added", id: result.insertedId });
  } catch {
    res.status(500).send({ error: "Failed to add user" });
  }
});

// DELETE user
app.delete("/users/:id", async (req, res) => {
  try {
    const result = await usersCol.deleteOne({ _id: new ObjectId(req.params.id) });
    res.send({ message: "User deleted", deletedCount: result.deletedCount });
  } catch {
    res.status(500).send({ error: "Failed to delete user" });
  }
});

// ========== COUPON ROUTES ==========

// GET all coupons
app.get("/coupons", async (req, res) => {
  try {
    const { code } = req.query;
    const query = code ? { code: { $regex: code, $options: "i" } } : {};
    const coupons = await couponsCol.find(query).toArray();
    res.send({ coupons });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to fetch coupons" });
  }
});

// POST new coupon
app.post("/coupons", async (req, res) => {
  try {
    const { code, discount, status } = req.body;

    if (!code || !discount) {
      return res.status(400).send({ error: "Code and discount are required" });
    }

    if (!["active", "inactive"].includes(status)) {
      return res.status(400).send({ error: "Invalid status" });
    }

    const existing = await couponsCol.findOne({ code });
    if (existing) {
      return res.status(400).send({ error: "Coupon code already exists" });
    }

    const newCoupon = {
      code,
      discount: parseFloat(discount),
      status: status || "active",
      createdAt: new Date(),
    };

    const result = await couponsCol.insertOne(newCoupon);
    res.status(201).send({ message: "Coupon added", id: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to add coupon" });
  }
});

// PUT update coupon
app.put("/coupons/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { code, discount, status } = req.body;

    const updateData = {};
    if (code) updateData.code = code;
    if (discount) updateData.discount = parseFloat(discount);
    if (status) {
      if (!["active", "inactive"].includes(status)) {
        return res.status(400).send({ error: "Invalid status" });
      }
      updateData.status = status;
    }

    if (code) {
      const existing = await couponsCol.findOne({ code, _id: { $ne: new ObjectId(id) } });
      if (existing) {
        return res.status(400).send({ error: "Coupon code already exists" });
      }
    }

    const result = await couponsCol.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Coupon not found" });
    }

    res.send({ message: "Coupon updated", modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to update coupon" });
  }
});

// DELETE coupon
app.delete("/coupons/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await couponsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Coupon not found" });
    }

    res.send({ message: "Coupon deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to delete coupon" });
  }
});

// ========== ANNOUNCEMENT ROUTES ==========

// GET all announcements
app.get("/announcements", async (req, res) => {
  try {
    const { title } = req.query;
    const query = title ? { title: { $regex: title, $options: "i" } } : {};
    const announcements = await announcementsCol.find(query).toArray();
    res.send({ announcements });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to fetch announcements" });
  }
});

// POST new announcement
app.post("/announcements", async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      return res.status(400).send({ error: "Title and content are required" });
    }

    const newAnnouncement = {
      title,
      content,
      createdAt: new Date(),
      createdBy: req.body.createdBy || "admin@example.com", // Replace with actual admin email from auth
    };

    const result = await announcementsCol.insertOne(newAnnouncement);
    res.status(201).send({ message: "Announcement added", id: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to add announcement" });
  }
});

// PUT update announcement
app.put("/announcements/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content } = req.body;

    const updateData = {};
    if (title) updateData.title = title;
    if (content) updateData.content = content;

    if (!title && !content) {
      return res.status(400).send({ error: "At least one field (title or content) is required" });
    }

    const result = await announcementsCol.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Announcement not found" });
    }

    res.send({ message: "Announcement updated", modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to update announcement" });
  }
});

// DELETE announcement
app.delete("/announcements/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await announcementsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Announcement not found" });
    }

    res.send({ message: "Announcement deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: "Failed to delete announcement" });
  }
});

// ROOT route
app.get("/", (req, res) => {
  res.send("🎾 SCMS API Running");
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});


