const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");

// Stripe
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cookieParser());
app.use(
  cors({
    origin: ["http://localhost:5173", "https://buildbox-a12.web.app"],
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

        // Update booking status to 'confirmed'
        const result = await bookingsCol.updateOne(
          { _id: new ObjectId(bookingId) },
          { $set: { paymentStatus: "completed", status: "Confirmed" } }
        );

        if (result.matchedCount === 0) {
          throw new Error("Booking not found");
        }

        console.log(`✅ Successfully processed payment for booking ${bookingId}`);
      } catch (dbError) {
        console.error("❌ Database update error after payment:", dbError);
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

let db, courtsCol, bookingsCol, usersCol, couponsCol, announcementsCol;

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
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1); // Exit process on connection failure
  }
}
connectDB();

// JWT Middleware
const verifyToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).send({ error: "No token provided" });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Attach decoded user data to request
    next();
  } catch (err) {
    console.error("❌ Invalid token:", err.message);
    return res.status(401).send({ error: "Invalid token" });
  }
};

// JWT Route
app.post("/jwt", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).send({ error: "Email is required" });
  }
  const user = { email };
  const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "2h" });
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // Secure in production
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // Adjust for local dev
  });
  res.send({ message: "Token sent", status: true });
});

// Logout Route
app.post("/logout", (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    path: "/",
  });
  res.send({ message: "Logged out successfully" });
});

// ========== PAYMENT ROUTES ==========/

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
    console.error("❌ Coupon validation error:", err);
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
      amount,
      currency: "usd",
      payment_method_types: ["card"],
      metadata: {
        bookingId: bookingId.toString(),
      },
    });

    res.send({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (err) {
    console.error("❌ Stripe Error:", err);
    res.status(500).send({ error: "Failed to create payment intent" });
  }
});

// ========== COURT ROUTES ==========

// GET all courts
app.get("/courts", async (req, res) => {
  try {
    const courts = await courtsCol.find().toArray();
    res.send({ courts });
  } catch (err) {
    console.error("❌ Error fetching courts:", err);
    res.status(500).send({ error: "Failed to fetch courts" });
  }
});

// POST new court
app.post("/courts", verifyToken, async (req, res) => {
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
  } catch (err) {
    console.error("❌ Error adding court:", err);
    res.status(500).send({ error: "Failed to add court" });
  }
});

// PUT update court
app.put("/courts/:id", verifyToken, async (req, res) => {
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

    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Court not found" });
    }

    res.send({ message: "Court updated", modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error("❌ Error updating court:", err);
    res.status(500).send({ error: "Failed to update court" });
  }
});

// DELETE a court
app.delete("/courts/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await courtsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Court not found" });
    }

    res.send({ message: "Court deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error("❌ Error deleting court:", err);
    res.status(500).send({ error: "Failed to delete court" });
  }
});

// ========== BOOKINGS ROUTES ==========

// GET all bookings with optional filters
app.get("/bookings", verifyToken, async (req, res) => {
  try {
    const { status, paymentStatus, courtName, userId } = req.query;

    const query = {};
    if (status) query.status = status;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (userId) query.userId = userId;

    const pipeline = [
      { $match: query },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "uid",
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
      { $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$courtDetails", preserveNullAndEmptyArrays: true } },
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
          transactionId: 1,
          createdAt: 1,
        },
      },
    ];

    const bookings = await bookingsCol.aggregate(pipeline).toArray();
    res.send({ bookings });
  } catch (err) {
    console.error("❌ Error fetching bookings:", err);
    res.status(500).send({ error: "Failed to fetch bookings" });
  }
});

// POST a new booking
app.post("/bookings", verifyToken, async (req, res) => {
  try {
    const { courtId, userId, userEmail, slots, date, price } = req.body;

    if (!courtId || !userId || !userEmail || !slots || !Array.isArray(slots) || slots.length === 0 || !date || !price) {
      return res.status(400).send({ error: "All fields required and slots must be a non-empty array" });
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
    console.error("❌ Error creating booking:", err);
    res.status(500).send({ error: "Failed to create booking" });
  }
});

// PUT update booking status AND promote user to 'member'
app.put("/bookings/:id/status", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userEmail, userId } = req.body;

    if (!["Approved", "Rejected"].includes(status)) {
      return res.status(400).send({ error: "Invalid status" });
    }

    const booking = await bookingsCol.findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).send({ error: "Booking not found" });

    await bookingsCol.updateOne({ _id: new ObjectId(id) }, { $set: { status } });

    let emailToUpdate = userEmail || booking.userEmail;
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
    console.error("❌ Error updating booking status:", err);
    res.status(500).send({ error: "Failed to update booking status" });
  }
});

// DELETE a booking by ID
app.delete("/bookings/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await bookingsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Booking not found" });
    }

    res.send({ message: "Booking deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error("❌ Error deleting booking:", err);
    res.status(500).send({ error: "Failed to delete booking" });
  }
});

// PUT update booking payment status
app.put("/bookings/:id/payment", verifyToken, async (req, res) => {
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
    console.error("❌ Error updating payment status:", err);
    res.status(500).send({ error: "Failed to update booking payment status" });
  }
});

// ========== USER ROUTES ==========

// GET all users
app.get("/users", verifyToken, async (req, res) => {
  try {
    const users = await usersCol.find().toArray();
    res.send({ users });
  } catch (err) {
    console.error("❌ Error fetching users:", err);
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
  } catch (err) {
    console.error("❌ Error adding user:", err);
    res.status(500).send({ error: "Failed to add user" });
  }
});

// DELETE user
app.delete("/users/:id", verifyToken, async (req, res) => {
  try {
    const result = await usersCol.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "User not found" });
    }
    res.send({ message: "User deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error("❌ Error deleting user:", err);
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
    console.error("❌ Error fetching coupons:", err);
    res.status(500).send({ error: "Failed to fetch coupons" });
  }
});

// POST new coupon
app.post("/coupons", verifyToken, async (req, res) => {
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
    console.error("❌ Error adding coupon:", err);
    res.status(500).send({ error: "Failed to add coupon" });
  }
});

// PUT update coupon
app.put("/coupons/:id", verifyToken, async (req, res) => {
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
    console.error("❌ Error updating coupon:", err);
    res.status(500).send({ error: "Failed to update coupon" });
  }
});

// DELETE coupon
app.delete("/coupons/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await couponsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Coupon not found" });
    }

    res.send({ message: "Coupon deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error("❌ Error deleting coupon:", err);
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
    console.error("❌ Error fetching announcements:", err);
    res.status(500).send({ error: "Failed to fetch announcements" });
  }
});

// POST new announcement
app.post("/announcements", verifyToken, async (req, res) => {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      return res.status(400).send({ error: "Title and content are required" });
    }

    const newAnnouncement = {
      title,
      content,
      createdAt: new Date(),
      createdBy: req.user.email || "admin@example.com", // Use authenticated user email
    };

    const result = await announcementsCol.insertOne(newAnnouncement);
    res.status(201).send({ message: "Announcement added", id: result.insertedId });
  } catch (err) {
    console.error("❌ Error adding announcement:", err);
    res.status(500).send({ error: "Failed to add announcement" });
  }
});

// PUT update announcement
app.put("/announcements/:id", verifyToken, async (req, res) => {
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
    console.error("❌ Error updating announcement:", err);
    res.status(500).send({ error: "Failed to update announcement" });
  }
});

// DELETE announcement
app.delete("/announcements/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await announcementsCol.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send({ error: "Announcement not found" });
    }

    res.send({ message: "Announcement deleted", deletedCount: result.deletedCount });
  } catch (err) {
    console.error("❌ Error deleting announcement:", err);
    res.status(500).send({ error: "Failed to delete announcement" });
  }
});

// Payment history
app.post("/payment-success", async (req, res) => {
  const { bookingId, transactionId } = req.body;

  try {
    const result = await bookingsCol.updateOne(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          paymentStatus: "paid",
          transactionId,
          paidAt: new Date(),
        },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).send({ error: "Booking not found" });
    }

    res.send({ success: true });
  } catch (err) {
    console.error("Error updating booking after payment:", err);
    res.status(500).send({ error: "Internal Server Error" });
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

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("🛑 SIGTERM received. Closing MongoDB connection...");
  await client.close();
  process.exit(0);
});