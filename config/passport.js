const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/api/auth/google/callback",
    proxy: true
},
    async function (accessToken, refreshToken, profile, done) {
        console.log('Passport Google Strategy Executing...');
        console.log('Received Profile:', profile ? profile.id : 'No Profile');

        try {
            // Check if user exists
            console.log('Checking for existing user with googleId:', profile.id);
            let user = await User.findOne({ googleId: profile.id });

            if (user) {
                console.log('User found by googleId:', user.email);
                return done(null, user);
            }

            console.log('User not found by googleId, checking by email:', profile.emails[0].value);

            // Check if user exists with same email (link accounts)
            user = await User.findOne({ email: profile.emails[0].value });

            if (user) {
                console.log('User found by email. Linking googleId to existing account:', user.email);
                user.googleId = profile.id;
                await user.save();
                console.log('User account linked successfully.');
                return done(null, user);
            }

            console.log('No existing user found. Creating new user.');

            // Check if this is the first user
            const userCount = await User.countDocuments();
            const role = userCount === 0 ? 'admin' : 'user';
            console.log('Assigning role:', role);

            // Create new user
            user = new User({
                name: profile.displayName,
                email: profile.emails[0].value,
                googleId: profile.id,
                role: role
            });

            await user.save();
            console.log('New user created successfully:', user.email, 'with role:', role);

            // Create default settings for new user
            const Settings = require('../models/Settings');
            const defaultSettings = new Settings({ userId: user._id });
            await defaultSettings.save();
            console.log('Default settings created for new user:', user.email);

            return done(null, user);
        } catch (err) {
            console.error('Passport Google Strategy Error:', err);
            return done(err, null);
        }
    }
));

module.exports = passport;
