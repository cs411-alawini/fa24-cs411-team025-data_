const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const util = require('util');
const session = require('express-session');
const flash = require('express-flash');

const app = express();

// Middleware for JSON parsing
app.use(express.json());

// Set the view engine to EJS
app.set('view engine', 'ejs');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());


app.use(
    session({
        secret: "f3c2e8c4b8a7281b7d5e5a9c9f7d2f1c93a1e2b4c5d6f7a9b0e1c2d3e4f5g6h7",
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false }, 
    })
);


app.use(flash());

// Database connection
const db = mysql.createConnection({
    host: '34.55.108.198',
    user: 'root',
    password: 'password1234',
    database: 'proj',
});

// Promisify database methods
const beginTransaction = util.promisify(db.beginTransaction).bind(db);
const queryAsync = util.promisify(db.query).bind(db);
const commit = util.promisify(db.commit).bind(db);
const rollback = util.promisify(db.rollback).bind(db);

// Test the database connection
db.connect((err) => {
    if (err) {
        console.error('Error connecting to the database:', err);
    } else {
        console.log('Connected to the GCP SQL database');
    }
});

app.post('/signup', (req, res) => {
    const { username, email, first_name, last_name, language } = req.body;
    console.log('Received data:', req.body);
    
    const checkQuery = 'SELECT * FROM users WHERE username = ?';
    db.query(checkQuery, [username], (err, results) => {
        if (err) {
            console.error('Error checking username:', err);
            return res.status(500).send('Error checking username');
        }

        if (results.length > 0) {
            return res.status(400).send('Username already exists');
        }

        const insertQuery = `
            INSERT INTO users (username, email, points, first_name, last_name, Language)
            VALUES (?, ?, 0, ?, ?, ?)
        `;
        db.query(insertQuery, [username, email, first_name, last_name, language], (err, results) => {
            if (err) {
                console.error('Error inserting user:', err);
                return res.status(500).send('Error creating user');
            }
            res.redirect('/dashboard?username=' + username);
        });
    });
});

app.post('/login', (req, res) => {
    const { username } = req.body;

    const query = 'SELECT * FROM users WHERE username = ?';
    db.query(query, [username], (err, results) => {
        if (err) {
            console.error('Error fetching user:', err);
            return res.status(500).send('Error logging in');
        }

        if (results.length === 0) {
            return res.status(401).send('User not found. Please create an account.');
        }

        const user = results[0];
        req.session.user = {
            username: user.username,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            points: user.points,
            language: user.Language,
        };
        res.redirect('/dashboard');
    });
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.get('/signup', (req, res) => {
    console.log('Signup page accessed');
    res.render('signup');
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const username = req.session.user.username;

    const suggestionsQuery = `
        SELECT potential_friend.friendname2 AS suggested_friend, COUNT(mutual_friends.friendname2) AS mutual_friend_count
        FROM friends AS direct_friends 
        JOIN friends AS mutual_friends ON direct_friends.friendname2 = mutual_friends.friendname1
        JOIN friends AS potential_friend ON mutual_friends.friendname2 = potential_friend.friendname2
        WHERE direct_friends.friendname1 = ? 
          AND potential_friend.friendname2 != ? 
          AND potential_friend.friendname2 NOT IN (
              SELECT friendname2 
              FROM friends 
              WHERE friendname1 = ? 
          ) 
          AND (
              (SELECT Language
               FROM users
               WHERE users.username = mutual_friends.friendname1) IN
              (SELECT Language
               FROM users
               WHERE users.username = potential_friend.friendname1)
          )
        GROUP BY potential_friend.friendname2 
        HAVING COUNT(mutual_friends.friendname2) >= 1
        ORDER BY mutual_friend_count DESC;
    `;

    try {
        await queryAsync('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await beginTransaction();

        const procedureCall = 'CALL assignRankCategories(?)';
        const [categorizedFriends] = await queryAsync(procedureCall, [username]);

        const [suggestions] = await queryAsync(suggestionsQuery, [username, username, username]);
        
        if (!Array.isArray(suggestions)) {
            console.error('Suggestions is not an array:', suggestions);
            const suggestionsArray = suggestions ? [suggestions] : [];
            
            await commit();
            return res.render('dashboard', {
                user: req.session.user,
                leaderboard: categorizedFriends,
                suggestions: suggestionsArray
            });
        }

        await commit();

        res.render('dashboard', {
            user: req.session.user,
            leaderboard: categorizedFriends,
            suggestions: suggestions
        });

    } catch (err) {
        try {
            await rollback();
        } catch (rollbackErr) {
            console.error('Rollback Error:', rollbackErr);
        }
        console.error('Transaction error in /dashboard:', err);
        res.status(500).send('Error loading dashboard');
    }
});

app.post('/add-suggested-friend', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const username = req.session.user.username;
    const { suggestedUsername } = req.body;

    try {
        // Start a transaction
        await queryAsync('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await beginTransaction();

        // Call the stored procedure
        const [results] = await queryAsync('CALL addSuggestedFriend(?, ?, @success)', [username, suggestedUsername]);
        const [[{ success }]] = await queryAsync('SELECT @success as success');

        if (success) {
            // Force a delay to ensure triggers have completed
            await new Promise(resolve => setTimeout(resolve, 100));

            // Get the updated user data with a direct query
            const [updatedUserRows] = await queryAsync(
                'SELECT username, email, points, first_name, last_name, Language FROM users WHERE username = ?',
                [username]
            );

            if (updatedUserRows.length > 0) {
                const updatedUser = updatedUserRows[0];
                // Update session with fresh data
                req.session.user = {
                    username: updatedUser.username,
                    email: updatedUser.email,
                    first_name: updatedUser.first_name,
                    last_name: updatedUser.last_name,
                    points: updatedUser.points,
                    language: updatedUser.Language
                };

                // Explicitly save the session
                await new Promise((resolve, reject) => {
                    req.session.save(err => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            await commit();
            req.flash('success', 'Friend added successfully!');
        } else {
            await commit();
            req.flash('error', 'Could not add friend. They might already be your friend or not a valid suggestion.');
        }

        res.redirect('/dashboard');
    } catch (err) {
        await rollback();
        console.error('Error adding suggested friend:', err);
        req.flash('error', 'Error adding friend');
        res.redirect('/dashboard');
    }
});

// Search and Add Friend
app.post('/add-friend', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const username = req.session.user.username;
    const { friendUsername } = req.body;

    const checkFriendExists = `
        SELECT * FROM users WHERE username = ?;
    `;
    const checkAlreadyFriends = `
        SELECT * FROM friends 
        WHERE (friendname1 = ? AND friendname2 = ?) 
           OR (friendname1 = ? AND friendname2 = ?);
    `;
    const addFriendQuery = `
        INSERT INTO friends (friendname1, friendname2) VALUES (?, ?);
    `;

    // First check if the friend exists
    db.query(checkFriendExists, [friendUsername], (err, results) => {
        if (err) {
            console.error('Error checking friend:', err);
            return res.status(500).redirect('/dashboard');
        }

        if (results.length === 0) {
            return res.status(400).redirect('/dashboard');
        }

        // Then check if they're already friends
        db.query(checkAlreadyFriends, [username, friendUsername, friendUsername, username], (err, results) => {
            if (err) {
                console.error('Error checking existing friendship:', err);
                return res.status(500).redirect('/dashboard');
            }

            if (results.length > 0) {
                return res.redirect('/dashboard');
            }

            // Add both friendship records
            db.query(addFriendQuery, [username, friendUsername], (err) => {
                if (err) {
                    console.error('Error adding first friendship:', err);
                    return res.status(500).redirect('/dashboard');
                }

                // Add reverse friendship
                db.query(addFriendQuery, [friendUsername, username], (err) => {
                    if (err) {
                        console.error('Error adding reverse friendship:', err);
                        return res.status(500).redirect('/dashboard');
                    }

                    // Update session with complete user data
                    const refreshUserQuery = 'SELECT * FROM users WHERE username = ?';
                    db.query(refreshUserQuery, [username], (err, results) => {
                        if (!err && results.length > 0) {
                            const updatedUser = results[0];
                            req.session.user = {
                                username: updatedUser.username,
                                email: updatedUser.email,
                                first_name: updatedUser.first_name,
                                last_name: updatedUser.last_name,
                                points: updatedUser.points,
                                language: updatedUser.Language
                            };
                            res.redirect('/dashboard');
                        } else {
                            res.redirect('/dashboard');
                        }
                    });
                });
            });
        });
    });
});

// Remove Friend
app.post('/remove-friend/:friendUsername', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const username = req.session.user.username;
    const friendUsername = req.params.friendUsername;

    const removeFriendQuery = `
        DELETE FROM friends 
        WHERE (friendname1 = ? AND friendname2 = ?) OR (friendname1 = ? AND friendname2 = ?);
    `;

    db.query(removeFriendQuery, [username, friendUsername, friendUsername, username], (err) => {
        if (err) {
            console.error('Error removing friend:', err);
            return res.status(500).send('Error removing friend');
        }

        // Update session with new points
        db.query('SELECT points FROM users WHERE username = ?', [username], (err, results) => {
            if (!err && results.length > 0) {
                req.session.user.points = results[0].points;
            }
            res.redirect('/dashboard');
        });
    });
});

app.get('/search-suggestions', (req, res) => {
    const { term } = req.query;

    if (!term) {
        return res.json([]);
    }

    const searchQuery = `
        SELECT username 
        FROM users 
        WHERE username LIKE ? 
        LIMIT 10;
    `;

    db.query(searchQuery, [`%${term}%`], (err, results) => {
        if (err) {
            console.error('Error fetching search suggestions:', err);
            return res.status(500).send('Error fetching suggestions');
        }

        res.json(results.map((user) => user.username));
    });
});

app.get('/monuments', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const username = req.session.user.username;

    const query = `
        SELECT Monument, city, country 
        FROM monuments 
        WHERE country IN (
            SELECT L.country 
            FROM users U 
            JOIN country_languages L 
            ON U.Language = L.Language 
            WHERE U.username = ?
        );
    `;
    db.query(query, [username], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            res.status(500).send('Error fetching monuments');
        } else {
            res.render('monuments', { monuments: results });
        }
    });
});

app.get('/dishes', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const username = req.session.user.username;

    const query = `
        SELECT dish, city, country 
        FROM dishes 
        WHERE country IN (
            SELECT L.country 
            FROM users U 
            JOIN country_languages L 
            ON U.Language = L.Language 
            WHERE U.username = ?
        );
    `;
    db.query(query, [username], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            res.status(500).send('Error fetching dishes');
        } else {
            res.render('dishes', { dishes: results });
        }
    });
});

app.get('/learn', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const userLanguage = req.session.user.language;

    const query = `
        SELECT english_phrase, translation, pronunciation 
        FROM combined_phrases 
        WHERE language = ? 
        ORDER BY RAND() 
        LIMIT 10;
    `;

    db.query(query, [userLanguage], (err, phrases) => {
        if (err) {
            console.error('Error fetching learning phrases:', err.message);
            return res.status(500).render('error', { 
                message: 'Unable to load learning tab. Please try again later.' 
            });
        }

        res.render('learn', {
            user: req.session.user,
            phrases,
        });
    });
});

app.get('/quiz', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const userLanguage = req.session.user.language;

    const query = `
        SELECT id, english_phrase, translation 
        FROM combined_phrases 
        WHERE language = ? 
        ORDER BY RAND() 
        LIMIT 10;
    `;

    db.query(query, [userLanguage], (err, questions) => {
        if (err) {
            console.error('Error fetching quiz questions:', err);
            return res.status(500).send('Error loading quiz');
        }

        const questionPromises = questions.map((question) => {
            return new Promise((resolve, reject) => {
                const optionsQuery = `
                    SELECT translation 
                    FROM combined_phrases 
                    WHERE language = ? AND id != ? 
                    ORDER BY RAND() 
                    LIMIT 3;
                `;

                db.query(optionsQuery, [userLanguage, question.id], (err, options) => {
                    if (err) {
                        return reject(err);
                    }

                    resolve({
                        ...question,
                        options: [question.translation, ...options.map((opt) => opt.translation)]
                            .sort(() => Math.random() - 0.5),
                    });
                });
            });
        });

        Promise.all(questionPromises)
            .then((questionsWithOptions) => {
                res.render('quiz', {
                    user: req.session.user,
                    questions: questionsWithOptions,
                });
            })
            .catch((err) => {
                console.error('Error fetching options for quiz:', err);
                res.status(500).send('Error loading quiz');
            });
    });
});

app.post('/quiz/submit', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const { answers } = req.body;
    const username = req.session.user.username;

    const query = `
        SELECT id, english_phrase, translation, LENGTH(translation) - LENGTH(REPLACE(translation, ' ', '')) + 1 AS word_count
        FROM combined_phrases
        WHERE id IN (?)
    `;

    db.query(query, [Object.keys(answers)], (err, correctAnswers) => {
        if (err) {
            console.error('Error validating answers:', err);
            return res.status(500).send('Error processing quiz');
        }

        const results = correctAnswers.map((phrase) => ({
            ...phrase,
            userAnswer: answers[phrase.id],
            isCorrect: answers[phrase.id] === phrase.translation,
        }));

        const pointsEarned = results
            .filter((result) => result.isCorrect)
            .reduce((sum, result) => sum + result.word_count, 0);

        const updatePointsQuery = `
            UPDATE users
            SET points = points + ?
            WHERE username = ?;
        `;

        db.query(updatePointsQuery, [pointsEarned, username], (updateErr) => {
            if (updateErr) {
                console.error('Error updating user points:', updateErr);
                console.error('Error updating user points:', updateErr);
                return res.status(500).send('Error updating points');
            }

            req.session.user.points += pointsEarned; // Update session points
            req.session.quizResults = results; // Store results in session for "Next" page
            req.session.pointsEarned = pointsEarned; // Store points earned

            res.render('quiz-results', {
                user: req.session.user,
                results,
                pointsEarned,
            });
        });
    });
});

app.get('/quiz/score', (req, res) => {
    if (!req.session.user || !req.session.quizResults) {
        return res.redirect('/login');
    }

    const results = req.session.quizResults;
    const pointsEarned = req.session.pointsEarned;

    req.session.quizResults = null; // Clear results from session
    req.session.pointsEarned = null; // Clear points from session

    res.render('quiz-score', {
        user: req.session.user,
        score: pointsEarned,
    });
});

app.get('/cloze-quiz', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const userLanguage = req.session.user.language;

    if (!req.session.clozeQuestions) {
        const query = `
            SELECT id, translation 
            FROM combined_phrases 
            WHERE language = ? AND LENGTH(translation) - LENGTH(REPLACE(translation, ' ', '')) + 1 > 3
            ORDER BY RAND() 
            LIMIT 10;
        `;

        db.query(query, [userLanguage], (err, phrases) => {
            if (err) {
                console.error('Error fetching cloze quiz questions:', err);
                return res.status(500).send('Error loading quiz');
            }

            const questionPromises = phrases.map((phrase) => {
                return new Promise((resolve, reject) => {
                    const words = phrase.translation.split(' ');
                    let blankIndex = Math.floor(Math.random() * words.length);

                    while (!words[blankIndex].match(/^[a-zA-Z]+$/)) {
                        blankIndex = Math.floor(Math.random() * words.length);
                    }

                    const correctWord = words[blankIndex];
                    const incompleteTranslation = words
                        .map((word, idx) => (idx === blankIndex ? '__________' : word))
                        .join(' ');

                    const distractorQuery = `
                        SELECT DISTINCT translation 
                        FROM combined_phrases 
                        WHERE language = ? 
                        ORDER BY RAND() 
                        LIMIT 10;
                    `;

                    db.query(distractorQuery, [userLanguage], (err, distractors) => {
                        if (err) return reject(err);

                        const validDistractors = distractors
                            .map((d) => d.translation.split(' ')[0])
                            .filter((opt) => 
                                opt.match(/^[a-zA-Z]+$/) && 
                                opt !== correctWord
                            );

                        const uniqueDistractors = [...new Set(validDistractors)]
                            .slice(0, 3);

                        if (uniqueDistractors.length < 3) {
                            return reject(new Error('Not enough unique distractors'));
                        }

                        const options = [correctWord, ...uniqueDistractors].sort(() => Math.random() - 0.5);

                        resolve({
                            id: phrase.id,
                            incompleteTranslation,
                            correctWord,
                            options,
                        });
                    });
                });
            });

            Promise.all(questionPromises)
                .then((questions) => {
                    req.session.clozeQuestions = questions;
                    res.render('cloze-quiz', {
                        user: req.session.user,
                        questions,
                    });
                })
                .catch((err) => {
                    console.error('Error preparing cloze quiz questions:', err);
                    res.status(500).send('Error loading quiz');
                });
        });
    } else {
        res.render('cloze-quiz', {
            user: req.session.user,
            questions: req.session.clozeQuestions,
        });
    }
});

app.post('/cloze-quiz/submit', (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    const { answers } = req.body;
    const username = req.session.user.username;

    const questions = req.session.clozeQuestions;
    if (!questions || questions.length === 0) {
        console.error('No questions found in session.');
        return res.status(400).send('Error: No questions available for validation.');
    }

    let pointsEarned = 0;

    const results = questions.map((question) => {
        const isCorrect = answers[question.id] === question.correctWord;

        if (isCorrect) {
            pointsEarned += 1;
        }

        return {
            ...question,
            userAnswer: answers[question.id],
            isCorrect,
        };
    });

    const updatePointsQuery = `
        UPDATE users 
        SET points = points + ? 
        WHERE username = ?;
    `;

    db.query(updatePointsQuery, [pointsEarned, username], (err) => {
        if (err) {
            console.error('Error updating user points:', err);
            return res.status(500).send('Error updating points');
        }

        req.session.user.points += pointsEarned;
        req.session.clozeQuestions = null;

        res.render('cloze-quiz-results', {
            user: req.session.user,
            results,
            score: pointsEarned,
        });
    });
});

// Start the server
const PORT = 80;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});