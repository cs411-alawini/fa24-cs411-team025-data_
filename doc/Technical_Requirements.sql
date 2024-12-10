-- TRANSACTIONS --
-- 1) Transaction for Dashboard 
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

-- 2) Transaction for Suggested Friend Query
try {

        await queryAsync('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await beginTransaction();
        const [results] = await queryAsync('CALL addSuggestedFriend(?, ?, @success)', [username, suggestedUsername]);
        const [[{ success }]] = await queryAsync('SELECT @success as success');

        if (success) {
            await new Promise(resolve => setTimeout(resolve, 100));

            const [updatedUserRows] = await queryAsync(
                'SELECT username, email, points, first_name, last_name, Language FROM users WHERE username = ?',
                [username]
            );

            if (updatedUserRows.length > 0) {
                const updatedUser = updatedUserRows[0];
                req.session.user = {
                    username: updatedUser.username,
                    email: updatedUser.email,
                    first_name: updatedUser.first_name,
                    last_name: updatedUser.last_name,
                    points: updatedUser.points,
                    language: updatedUser.Language
                };

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


-- STORED PROCEDURES --
-- 1) Procedure to assign Rank on the Leaderboard
CREATE PROCEDURE assignRankCategories(IN current_username VARCHAR(50))
BEGIN
    DECLARE total_friends INT;
    DECLARE gold_cutoff INT;
    DECLARE silver_cutoff INT;
    DECLARE bronze_cutoff INT;

    -- Get total number of friends
    SELECT COUNT(*) INTO total_friends
    FROM friends
    WHERE friendname1 = current_username OR friendname2 = current_username;

    -- Calculate cutoffs based on new percentages
    -- Gold: top 5%
    -- Silver: next 15%
    -- Bronze: next 20%
    -- Rest: unranked
    SET gold_cutoff = CEILING(total_friends * 0.05);    -- Top 5%
    SET silver_cutoff = CEILING(total_friends * 0.20);  -- Top 20% (5% + 15%)
    SET bronze_cutoff = CEILING(total_friends * 0.40);  -- Top 40% (5% + 15% + 20%)

    SELECT 
        U.username,
        U.points,
        U.first_name,
        U.last_name,
        CASE
            WHEN U.user_rank <= gold_cutoff THEN 'Gold'
            WHEN U.user_rank <= silver_cutoff THEN 'Silver'
            WHEN U.user_rank <= bronze_cutoff THEN 'Bronze'
            ELSE 'Unranked'
        END AS rank_category
    FROM (
        SELECT 
            username,
            points,
            first_name,
            last_name,
            ROW_NUMBER() OVER (ORDER BY points DESC) AS user_rank
        FROM users
        WHERE username IN (
            SELECT 
                CASE 
                    WHEN friendname1 = current_username THEN friendname2 
                    ELSE friendname1 
                END AS friend
            FROM friends
            WHERE friendname1 = current_username 
               OR friendname2 = current_username
        )
    ) AS U
    ORDER BY U.user_rank ASC;
END$$

-- 2) Procedure to recommend and add suggested friends based on having a mutual friend and learning the same language
CREATE PROCEDURE addSuggestedFriend(
    IN current_username VARCHAR(50),
    IN suggested_username VARCHAR(50),
    OUT success BOOLEAN
)
BEGIN
    DECLARE friend_exists INT;
    DECLARE is_valid_suggestion BOOLEAN;
    
    -- Start transaction for data consistency
    DECLARE EXIT HANDLER FOR SQLEXCEPTION 
    BEGIN
        ROLLBACK;
        SET success = FALSE;
    END;
    
    START TRANSACTION;
    
    -- Check if they're already friends
    SELECT COUNT(*) INTO friend_exists
    FROM friends 
    WHERE (friendname1 = current_username AND friendname2 = suggested_username)
       OR (friendname1 = suggested_username AND friendname2 = current_username);
    
    -- Verify this is actually a valid suggestion
    SELECT COUNT(*) > 0 INTO is_valid_suggestion
    FROM friends AS direct_friends 
    JOIN friends AS mutual_friends ON direct_friends.friendname2 = mutual_friends.friendname1
    JOIN friends AS potential_friend ON mutual_friends.friendname2 = potential_friend.friendname2
    WHERE direct_friends.friendname1 = current_username 
      AND potential_friend.friendname2 = suggested_username
      AND (
          (SELECT Language
           FROM users
           WHERE users.username = mutual_friends.friendname1) IN
          (SELECT Language
           FROM users
           WHERE users.username = potential_friend.friendname1)
      )
    GROUP BY potential_friend.friendname2 
    HAVING COUNT(mutual_friends.friendname2) >= 1;
    
    IF friend_exists = 0 AND is_valid_suggestion = TRUE THEN
        INSERT INTO friends (friendname1, friendname2) VALUES (current_username, suggested_username);
        INSERT INTO friends (friendname1, friendname2) VALUES (suggested_username, current_username);
        SET success = TRUE;
    ELSE
        SET success = FALSE;
    END IF;
    
    COMMIT;
END$$

-- TRIGGERS --
-- 1) Trigger to award points for adding new friends
CREATE TRIGGER after_friend_insert
AFTER INSERT ON friends
FOR EACH ROW
BEGIN
    DECLARE existing_friendship INT;
    DECLARE reverse_friendship INT;

    -- Check for existing friendship in both directions
    SELECT COUNT(*) INTO existing_friendship
    FROM friends
    WHERE friendname1 = NEW.friendname2 AND friendname2 = NEW.friendname1;

    SELECT COUNT(*) INTO reverse_friendship
    FROM friends
    WHERE friendname1 = NEW.friendname1 AND friendname2 = NEW.friendname2
    AND (friendname1, friendname2) != (NEW.friendname1, NEW.friendname2);

    -- Only award points if neither direction exists
    IF existing_friendship = 0 AND reverse_friendship = 0 THEN
        UPDATE users
        SET points = points + 5
        WHERE username = NEW.friendname1;
    END IF;
END$$

-- 2) Trigger to deduct points for adding new friends
CREATE TRIGGER after_friend_delete
AFTER DELETE ON friends
FOR EACH ROW
BEGIN
    DECLARE remaining_friendship INT;

    -- Check if there's still a friendship record between these users
    SELECT COUNT(*) INTO remaining_friendship
    FROM friends
    WHERE (friendname1 = OLD.friendname2 AND friendname2 = OLD.friendname1)
    OR (friendname1 = OLD.friendname1 AND friendname2 = OLD.friendname2);

    -- Only deduct points if this was the last friendship record between the users
    IF remaining_friendship = 0 THEN
        UPDATE users
        SET points = points - 5
        WHERE username IN (OLD.friendname1, OLD.friendname2);
    END IF;
END$$ CopyRetryClaude does not have the ability to run the code it generates yet.


-- CONSTRAINTS --
-- 1) Constraint to ensure that the email id provided is valid (includes "@" & "." symbols)
-- 2) Constraint to ensure that the email id provided is unique (to avoid duplicate accounts)
-- 3) Constraint to ensure that the language selected is one of French, German, Spanish, Portuguese as those are the only languages supported at the moment.
