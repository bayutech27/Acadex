// js/educational-quotes.js
// ═════════════════════════════════════════════════════════════════════════════
// Acadex — Daily Educational Quote Engine
// ═════════════════════════════════════════════════════════════════════════════
// Shows one educational/motivational quote once per calendar day, per user,
// per device — ONLY when explicitly called from a dashboard page.
//
//   import { initEducationalQuote } from './js/educational-quotes.js';
//   initEducationalQuote({ role: 'student', userId: currentUser.uid });
//   initEducationalQuote({ role: 'teacher', userId: currentUser.uid });
//
// Behaviour:
//   • One popup per (user, device, calendar day). Nothing more, ever, that day.
//   • Stays until the user closes it — no auto-dismiss.
//   • Shuffle button pulls a different quote from the same role pool.
//   • Close via ✕, backdrop, Esc, or "Continue".
//   • No opt-out — intentionally daily.
//   • Falls back to sessionStorage if localStorage is unavailable.
//   • Silently fails on any storage/error so it never blocks the dashboard.
//   • Never writes to Firestore. No security rules required.
//
// Attribution convention: quoted attributions follow popular usage. Where
// authorship is disputed or unknown, "Anonymous" or a cultural source
// (e.g. "Chinese Proverb") is used instead of a possibly incorrect name.
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT QUOTES — [text, author]
// ─────────────────────────────────────────────────────────────────────────────
const STUDENT_QUOTES = [
  // ── Learning & Curiosity ──
  ['The beautiful thing about learning is that no one can take it away from you.', 'B.B. King'],
  ['Live as if you were to die tomorrow. Learn as if you were to live forever.', 'Mahatma Gandhi'],
  ['The more that you read, the more things you will know. The more that you learn, the more places you will go.', 'Dr. Seuss'],
  ['Anyone who stops learning is old, whether at twenty or eighty.', 'Henry Ford'],
  ['Education is the most powerful weapon which you can use to change the world.', 'Nelson Mandela'],
  ['The mind is not a vessel to be filled, but a fire to be kindled.', 'Plutarch'],
  ['Curiosity is the wick in the candle of learning.', 'William Arthur Ward'],
  ['I have no special talent. I am only passionately curious.', 'Albert Einstein'],
  ['The important thing is not to stop questioning.', 'Albert Einstein'],
  ['Wonder is the beginning of wisdom.', 'Socrates'],
  ['Learning never exhausts the mind.', 'Leonardo da Vinci'],
  ['An investment in knowledge pays the best interest.', 'Benjamin Franklin'],
  ['There is no friend as loyal as a book.', 'Ernest Hemingway'],
  ['A book is a dream that you hold in your hands.', 'Neil Gaiman'],
  ['Once you learn to read, you will be forever free.', 'Frederick Douglass'],
  ['Education is not preparation for life; education is life itself.', 'John Dewey'],
  ['The whole purpose of education is to turn mirrors into windows.', 'Sydney J. Harris'],
  ['The roots of education are bitter, but the fruit is sweet.', 'Aristotle'],
  ['Education is the passport to the future, for tomorrow belongs to those who prepare for it today.', 'Malcolm X'],
  ['Develop a passion for learning. If you do, you will never cease to grow.', 'Anthony J. D\u2019Angelo'],
  ['Change is the end result of all true learning.', 'Leo Buscaglia'],
  ['The cure for boredom is curiosity. There is no cure for curiosity.', 'Dorothy Parker'],
  ['Learning is a treasure that will follow its owner everywhere.', 'Chinese Proverb'],
  ['To know what you know and what you do not know \u2014 that is true knowledge.', 'Confucius'],
  ['Knowledge is power. Information is liberating. Education is the premise of progress.', 'Kofi Annan'],
  ['When you know better, you do better.', 'Maya Angelou'],
  ['I am still learning.', 'Michelangelo'],
  ['Learn everything you can, anytime you can, from anyone you can \u2014 there will always come a time when you will be grateful you did.', 'Sarah Caldwell'],
  ['The true sign of intelligence is not knowledge but imagination.', 'Albert Einstein'],
  ['Imagination is more important than knowledge.', 'Albert Einstein'],
  ['Never let formal education get in the way of your learning.', 'Mark Twain'],
  ['If you think education is expensive, try ignorance.', 'Derek Bok'],
  ['The more I read, the more I acquire, the more certain I am that I know nothing.', 'Voltaire'],
  ['The purpose of learning is growth, and our minds, unlike our bodies, can continue growing as we continue to live.', 'Mortimer Adler'],
  ['You learn something every day if you pay attention.', 'Ray LeBlond'],
  ['Curiosity is one of the permanent and certain characteristics of a vigorous intellect.', 'Samuel Johnson'],
  ['The best way to predict your future is to create it.', 'Abraham Lincoln (attributed)'],
  ['A reader lives a thousand lives before he dies. The man who never reads lives only one.', 'George R.R. Martin'],
  ['Any fool can know. The point is to understand.', 'Albert Einstein'],
  ['A wise person knows that there is something to be learned from everyone.', 'Anonymous'],
  ['He who asks a question is a fool for five minutes; he who does not ask remains a fool forever.', 'Chinese Proverb'],
  ['Learning is the beginning of wealth. Learning is the beginning of health. Learning is the beginning of spirituality.', 'Jim Rohn'],
  ['The only source of knowledge is experience.', 'Albert Einstein'],
  ['Education is what remains after one has forgotten what one has learned in school.', 'Albert Einstein'],
  ['Intelligence plus character \u2014 that is the goal of true education.', 'Martin Luther King Jr.'],
  ['Learn from yesterday, live for today, hope for tomorrow. The important thing is not to stop questioning.', 'Albert Einstein'],
  ['Turn your wounds into wisdom.', 'Oprah Winfrey'],
  ['Try not to become a person of success. Rather become a person of value.', 'Albert Einstein'],
  ['The measure of intelligence is the ability to change.', 'Albert Einstein'],

  // ── Effort & Perseverance ──
  ['Success is the sum of small efforts repeated day in and day out.', 'Robert Collier'],
  ['The expert in anything was once a beginner.', 'Helen Hayes'],
  ['It always seems impossible until it is done.', 'Nelson Mandela'],
  ['Perseverance is not a long race; it is many short races one after the other.', 'Walter Elliot'],
  ['Fall seven times, stand up eight.', 'Japanese Proverb'],
  ['You do not have to be great to start, but you have to start to be great.', 'Zig Ziglar'],
  ['Do not watch the clock; do what it does. Keep going.', 'Sam Levenson'],
  ['The difference between ordinary and extraordinary is that little extra.', 'Jimmy Johnson'],
  ['Great things are done by a series of small things brought together.', 'Vincent van Gogh'],
  ['Patience and perseverance have a magical effect before which difficulties disappear and obstacles vanish.', 'John Quincy Adams'],
  ['Energy and persistence conquer all things.', 'Benjamin Franklin'],
  ['Victory is always possible for the person who refuses to stop fighting.', 'Napoleon Hill'],
  ['You may encounter many defeats, but you must not be defeated.', 'Maya Angelou'],
  ['When you feel like quitting, remember why you started.', 'Anonymous'],
  ['Rivers know this: there is no hurry. We shall get there some day.', 'A.A. Milne'],
  ['Continuous effort \u2014 not strength or intelligence \u2014 is the key to unlocking our potential.', 'Liane Cardes'],
  ['Dripping water hollows out stone, not through force but through persistence.', 'Ovid'],
  ['A river cuts through rock not because of its power but because of its persistence.', 'James N. Watkins'],
  ['It does not matter how slowly you go as long as you do not stop.', 'Confucius'],
  ['You are never too old to set another goal or to dream a new dream.', 'C.S. Lewis'],
  ['Start where you are. Use what you have. Do what you can.', 'Arthur Ashe'],
  ['It is not that I am so smart, it is just that I stay with problems longer.', 'Albert Einstein'],
  ['A little more persistence, a little more effort, and what seemed hopeless failure may turn to glorious success.', 'Elbert Hubbard'],
  ['The person who moves a mountain begins by carrying away small stones.', 'Confucius'],
  ['Success is walking from failure to failure with no loss of enthusiasm.', 'Winston Churchill (attributed)'],
  ['Great works are performed not by strength but by perseverance.', 'Samuel Johnson'],
  ['I never did anything worth doing by accident, nor did any of my inventions come by accident; they came by work.', 'Thomas Edison'],
  ['Opportunity is missed by most people because it is dressed in overalls and looks like work.', 'Thomas Edison'],
  ['There is no substitute for hard work.', 'Thomas Edison'],
  ['Genius is one percent inspiration and ninety-nine percent perspiration.', 'Thomas Edison'],
  ['Every artist was first an amateur.', 'Ralph Waldo Emerson'],
  ['The harder I work, the luckier I get.', 'Samuel Goldwyn'],
  ['Work hard in silence; let success make the noise.', 'Anonymous'],
  ['The only place where success comes before work is in the dictionary.', 'Vidal Sassoon'],
  ['A goal without a plan is just a wish.', 'Antoine de Saint-Exup\u00e9ry'],
  ['You do not get what you wish for; you get what you work for.', 'Anonymous'],
  ['Great things never came from comfort zones.', 'Neil Strauss'],
  ['There are no shortcuts to any place worth going.', 'Beverly Sills'],
  ['The pain you feel today will be the strength you feel tomorrow.', 'Anonymous'],
  ['Do something today that your future self will thank you for.', 'Anonymous'],
  ['Success is not always about greatness. It is about consistency. Consistent hard work gains success.', 'Dwayne Johnson'],
  ['There is no elevator to success. You have to take the stairs.', 'Zig Ziglar'],
  ['Believe in yourself. You are braver than you think, more talented than you know, and capable of more than you imagine.', 'Roy T. Bennett'],
  ['Perseverance is failing nineteen times and succeeding the twentieth.', 'Julie Andrews'],
  ['Never give up, for that is just the place and time that the tide will turn.', 'Harriet Beecher Stowe'],
  ['The future depends on what you do today.', 'Mahatma Gandhi'],
  ['Take pride in how far you have come. Have faith in how far you can go. But do not forget to enjoy the journey.', 'Michael Josephson'],
  ['Small daily improvements over time lead to stunning results.', 'Robin Sharma'],
  ['If you want to lift yourself up, lift up someone else.', 'Booker T. Washington'],
  ['Do not wait to strike till the iron is hot; but make it hot by striking.', 'William Butler Yeats'],
  ['There are no traffic jams along the extra mile.', 'Roger Staubach'],
  ['Do not wish it were easier. Wish you were better.', 'Jim Rohn'],
  ['If you really want to do something, you will find a way. If you do not, you will find an excuse.', 'Jim Rohn'],
  ['The secret of getting ahead is getting started.', 'Mark Twain'],
  ['The distance between dreams and reality is called discipline.', 'Anonymous'],
  ['Do not stop when you are tired. Stop when you are done.', 'Anonymous'],
  ['Your only limit is you.', 'Anonymous'],

  // ── Growth Mindset & Self-Belief ──
  ['Whether you think you can, or you think you cannot \u2014 you are right.', 'Henry Ford'],
  ['The only limit to our realization of tomorrow is our doubts of today.', 'Franklin D. Roosevelt'],
  ['Believe you can and you are halfway there.', 'Theodore Roosevelt'],
  ['Your attitude, not your aptitude, will determine your altitude.', 'Zig Ziglar'],
  ['A person who never made a mistake never tried anything new.', 'Albert Einstein'],
  ['You have power over your mind \u2014 not outside events. Realize this, and you will find strength.', 'Marcus Aurelius'],
  ['You are braver than you believe, stronger than you seem, and smarter than you think.', 'A.A. Milne'],
  ['Man often becomes what he believes himself to be.', 'Mahatma Gandhi'],
  ['The only person you are destined to become is the person you decide to be.', 'Ralph Waldo Emerson'],
  ['We are what we repeatedly do. Excellence, then, is not an act, but a habit.', 'Will Durant'],
  ['Growth is the only evidence of life.', 'John Henry Newman'],
  ['Be curious, not judgmental.', 'Walt Whitman'],
  ['The journey of a thousand miles begins with a single step.', 'Lao Tzu'],
  ['Do what you can, with what you have, where you are.', 'Theodore Roosevelt'],
  ['You do not have to see the whole staircase; just take the first step.', 'Martin Luther King Jr.'],
  ['Start by doing what is necessary; then do what is possible; and suddenly you are doing the impossible.', 'Francis of Assisi'],
  ['The future belongs to those who believe in the beauty of their dreams.', 'Eleanor Roosevelt'],
  ['Never bend your head. Always hold it high. Look the world straight in the eye.', 'Helen Keller'],
  ['Optimism is the faith that leads to achievement. Nothing can be done without hope and confidence.', 'Helen Keller'],
  ['Life is either a daring adventure or nothing at all.', 'Helen Keller'],
  ['The best way out is always through.', 'Robert Frost'],
  ['What we think determines what happens to us, so if we want to change our lives, we need to stretch our minds.', 'Wayne Dyer'],
  ['Self-belief and hard work will always earn you success.', 'Virat Kohli'],
  ['The only way to discover the limits of the possible is to go beyond them into the impossible.', 'Arthur C. Clarke'],
  ['Every champion was once a contender that refused to give up.', 'Anonymous'],
  ['Do not let yesterday take up too much of today.', 'Will Rogers'],
  ['It is not whether you get knocked down; it is whether you get up.', 'Vince Lombardi'],
  ['The greatest glory in living lies not in never falling, but in rising every time we fall.', 'Nelson Mandela'],
  ['The two most important days in your life are the day you are born and the day you find out why.', 'Mark Twain (attributed)'],
  ['Your life does not get better by chance, it gets better by change.', 'Jim Rohn'],
  ['If you do not like something, change it. If you cannot change it, change your attitude.', 'Maya Angelou'],
  ['Success is liking yourself, liking what you do, and liking how you do it.', 'Maya Angelou'],
  ['Nothing will work unless you do.', 'Maya Angelou'],
  ['If you want to fly, you have to give up the things that weigh you down.', 'Toni Morrison'],
  ['You define your own life. Do not let other people write your script.', 'Oprah Winfrey'],
  ['The biggest adventure you can take is to live the life of your dreams.', 'Oprah Winfrey'],
  ['Surround yourself only with people who are going to take you higher.', 'Oprah Winfrey'],
  ['You get in life what you have the courage to ask for.', 'Oprah Winfrey'],
  ['The difference between who you are and who you want to be is what you do.', 'Anonymous'],
  ['Dream it. Believe it. Build it.', 'Anonymous'],
  ['You cannot go back and change the beginning, but you can start where you are and change the ending.', 'C.S. Lewis'],
  ['Do not be embarrassed by your failures; learn from them and start again.', 'Richard Branson'],
  ['Your dreams do not work unless you do.', 'John C. Maxwell'],
  ['Success is achieved by developing our strengths, not by eliminating our weaknesses.', 'Marilyn vos Savant'],
  ['The most difficult thing is the decision to act; the rest is merely tenacity.', 'Amelia Earhart'],
  ['You must do the things you think you cannot do.', 'Eleanor Roosevelt'],
  ['No one can make you feel inferior without your consent.', 'Eleanor Roosevelt'],
  ['Believe in yourself and all that you are. Know that there is something inside you that is greater than any obstacle.', 'Christian D. Larson'],
  ['If you do not build your dream, someone else will hire you to help them build theirs.', 'Dhirubhai Ambani'],
  ['Once you choose hope, anything is possible.', 'Christopher Reeve'],
  ['Strength does not come from what you can do. It comes from overcoming the things you once thought you could not.', 'Rikki Rogers'],
  ['You become what you believe.', 'Oprah Winfrey'],
  ['Confidence comes not from always being right but from not fearing to be wrong.', 'Peter T. Mcintyre'],
  ['Every accomplishment starts with the decision to try.', 'John F. Kennedy (attributed)'],
  ['Act as if what you do makes a difference. It does.', 'William James'],
  ['Do not wait for the perfect moment; take the moment and make it perfect.', 'Zoey Sayward'],
  ['Whatever you can do or dream you can, begin it.', 'Johann Wolfgang von Goethe'],
  ['The best time to plant a tree was twenty years ago. The second best time is now.', 'Chinese Proverb'],

  // ── Failure, Resilience & Trying Again ──
  ['Failure is simply the opportunity to begin again, this time more intelligently.', 'Henry Ford'],
  ['Success is not final, failure is not fatal: it is the courage to continue that counts.', 'Winston Churchill (attributed)'],
  ['I have not failed. I have just found ten thousand ways that will not work.', 'Thomas Edison'],
  ['Do not judge me by my successes; judge me by how many times I fell down and got back up again.', 'Nelson Mandela'],
  ['Every strike brings me closer to the next home run.', 'Babe Ruth'],
  ['Our greatest glory is not in never falling, but in rising every time we fall.', 'Confucius'],
  ['Failure is the condiment that gives success its flavor.', 'Truman Capote'],
  ['Only those who dare to fail greatly can ever achieve greatly.', 'Robert F. Kennedy'],
  ['There is no failure except in no longer trying.', 'Elbert Hubbard'],
  ['The real mistake is not failing; it is to stop trying.', 'B.F. Skinner (adapted)'],
  ['Failure after long perseverance is much grander than never to have a striving good enough to be called a failure.', 'George Eliot'],
  ['Our greatest weakness lies in giving up. The most certain way to succeed is always to try just one more time.', 'Thomas Edison'],
  ['The season of failure is the best time for sowing the seeds of success.', 'Paramahansa Yogananda'],
  ['Mistakes are the portals of discovery.', 'James Joyce'],
  ['You cannot have a better tomorrow if you are thinking about yesterday all the time.', 'Charles F. Kettering'],
  ['The only real mistake is the one from which we learn nothing.', 'Henry Ford'],
  ['Every adversity, every failure, every heartache carries with it the seed of an equal or greater benefit.', 'Napoleon Hill'],
  ['When everything seems to be going against you, remember that the airplane takes off against the wind, not with it.', 'Henry Ford'],
  ['I cannot change the direction of the wind, but I can adjust my sails to always reach my destination.', 'Jimmy Dean'],
  ['The comeback is always stronger than the setback.', 'Anonymous'],
  ['Sometimes you win, sometimes you learn.', 'John Maxwell'],
  ['Failure is not the opposite of success; it is part of success.', 'Arianna Huffington'],
  ['Do not let the fear of striking out keep you from playing the game.', 'Babe Ruth'],
  ['Do not fear failure but rather fear not trying.', 'Roy T. Bennett'],
  ['I failed my way to success.', 'Thomas Edison'],
  ['Perseverance is the hard work you do after you get tired of doing the hard work you already did.', 'Newt Gingrich'],
  ['Keep going. Be all in.', 'Bryan Stevenson'],
  ['The person on top of the mountain did not fall there.', 'Vince Lombardi'],
  ['Somewhere, something incredible is waiting to be known.', 'Carl Sagan'],
  ['Never give up on what you really want to do. The person with big dreams is more powerful than one with all the facts.', 'Albert Einstein'],
  ['Imagination will often carry us to worlds that never were. But without it we go nowhere.', 'Carl Sagan'],
  ['Failure will never overtake me if my determination to succeed is strong enough.', 'Og Mandino'],
  ['I am not a product of my circumstances. I am a product of my decisions.', 'Stephen Covey'],
  ['I have missed more than nine thousand shots in my career. I have lost almost three hundred games. Twenty-six times I have been trusted to take the game-winning shot and missed. I have failed over and over and over again in my life. And that is why I succeed.', 'Michael Jordan'],
  ['You cannot stop the waves, but you can learn to surf.', 'Jon Kabat-Zinn'],
  ['When we are no longer able to change a situation, we are challenged to change ourselves.', 'Viktor Frankl'],
  ['Everything can be taken from a person but one thing: the last of the human freedoms \u2014 to choose one\u2019s attitude in any given set of circumstances.', 'Viktor Frankl'],
  ['Life is not about finding yourself. Life is about creating yourself.', 'George Bernard Shaw'],
  ['Every moment is a fresh beginning.', 'T.S. Eliot'],

  // ── Discipline, Focus & Character ──
  ['Discipline is the bridge between goals and accomplishment.', 'Jim Rohn'],
  ['Discipline is choosing between what you want now and what you want most.', 'Abraham Lincoln (attributed)'],
  ['The chains of habit are too light to be felt until they are too heavy to be broken.', 'Warren Buffett'],
  ['Motivation gets you going, but discipline keeps you growing.', 'John C. Maxwell'],
  ['Small disciplines repeated with consistency every day lead to great achievements gained slowly over time.', 'John C. Maxwell'],
  ['First we form habits, then they form us.', 'Rob Gilbert'],
  ['The successful warrior is the average person, with laser-like focus.', 'Bruce Lee'],
  ['Focus is a matter of deciding what things you are not going to do.', 'John Carmack'],
  ['Concentrate all your thoughts upon the work at hand. The sun\u2019s rays do not burn until brought to a focus.', 'Alexander Graham Bell'],
  ['It is not enough to be busy. So are the ants. The question is: what are we busy about?', 'Henry David Thoreau'],
  ['Ordinary people think merely of spending time. Great people think of using it.', 'Arthur Schopenhauer'],
  ['Lack of direction, not lack of time, is the problem. We all have twenty-four-hour days.', 'Zig Ziglar'],
  ['Time is what we want most, but what we use worst.', 'William Penn'],
  ['You will never find time for anything. If you want time, you must make it.', 'Charles Buxton'],
  ['If you spend too much time thinking about a thing, you will never get it done.', 'Bruce Lee'],
  ['The way to get started is to quit talking and begin doing.', 'Walt Disney'],
  ['The secret of your future is hidden in your daily routine.', 'Mike Murdock'],
  ['Amateurs sit and wait for inspiration. The rest of us just get up and go to work.', 'Stephen King'],
  ['Consistency is the true foundation of trust.', 'Roy T. Bennett'],
  ['Practice is not the thing you do once you are good. It is the thing you do that makes you good.', 'Malcolm Gladwell'],
  ['Discipline is doing what you do not want to do, when you do not want to do it, so you can do what you want to do, when you want to do it.', 'Anonymous'],
  ['You do not have to be extreme, just consistent.', 'Anonymous'],
  ['Your future is created by what you do today, not tomorrow.', 'Robert Kiyosaki'],
  ['You will never change your life until you change something you do daily.', 'Mike Murdock'],
  ['Discipline equals freedom.', 'Jocko Willink'],
  ['Motivation is what gets you started. Habit is what keeps you going.', 'Jim Ryun'],
  ['You do not rise to the level of your goals. You fall to the level of your systems.', 'James Clear'],
  ['Every action you take is a vote for the type of person you wish to become.', 'James Clear'],
  ['The quality of your life is the quality of your habits.', 'Anonymous'],
  ['Winners are not people who never fail, but people who never quit.', 'Anonymous'],
  ['It is not the will to win that matters \u2014 everyone has that. It is the will to prepare to win that matters.', 'Bear Bryant'],
  ['The difference between a stumbling block and a stepping stone is how you use it.', 'Anonymous'],
  ['Be so good they cannot ignore you.', 'Steve Martin'],
  ['Your attention is the most valuable thing you own. Guard it fiercely.', 'Anonymous'],
  ['Every great thing requires a great sacrifice.', 'Anonymous'],
  ['You are what you do, not what you say you will do.', 'Carl Jung'],
  ['Show up. Do the work. Keep going. That is all there is.', 'Anonymous'],
  ['Do something today that your future self will thank you for.', 'Anonymous'],

  // ── Knowledge, Wisdom & Character ──
  ['The only true wisdom is in knowing you know nothing.', 'Socrates'],
  ['Wisdom begins in wonder.', 'Socrates'],
  ['Knowledge speaks, but wisdom listens.', 'Jimi Hendrix'],
  ['Knowing yourself is the beginning of all wisdom.', 'Aristotle'],
  ['The fool thinks he is wise, but the wise person knows himself to be a fool.', 'William Shakespeare'],
  ['Wisdom is not a product of schooling but of the lifelong attempt to acquire it.', 'Albert Einstein'],
  ['Wisdom is the reward you get for a lifetime of listening when you would have preferred to talk.', 'Doug Larson'],
  ['There are three things extremely hard: steel, a diamond, and to know one\u2019s self.', 'Benjamin Franklin'],
  ['It is better to know some of the questions than all of the answers.', 'James Thurber'],
  ['Knowledge will bring you the opportunity to make a difference.', 'Claire Fagin'],
  ['Wisdom is knowing what to do next; skill is knowing how to do it; and virtue is doing it.', 'David Starr Jordan'],
  ['There is no wealth like knowledge, no poverty like ignorance.', 'Ali ibn Abi Talib'],
  ['Knowledge is being aware that fire can burn; wisdom is remembering the burn.', 'Anonymous'],
  ['Whatever the mind can conceive and believe, it can achieve.', 'Napoleon Hill'],
  ['The best and most beautiful things in the world cannot be seen or even touched \u2014 they must be felt with the heart.', 'Helen Keller'],
  ['You only live once, but if you do it right, once is enough.', 'Mae West'],
  ['The function of education is to teach one to think intensively and to think critically. Intelligence plus character \u2014 that is the goal of true education.', 'Martin Luther King Jr.'],
  ['To educate a person in the mind but not in morals is to educate a menace to society.', 'Theodore Roosevelt'],
  ['Do not be too timid and squeamish about your actions. All life is an experiment.', 'Ralph Waldo Emerson'],
  ['A person who has never made a mistake has never tried anything new.', 'Albert Einstein'],
  ['The only place where success comes before work is in the dictionary.', 'Vidal Sassoon'],
  ['Character is what you are in the dark.', 'Dwight L. Moody'],
  ['Real integrity is doing the right thing, knowing that nobody is going to know whether you did it or not.', 'Oprah Winfrey'],
  ['The time is always right to do what is right.', 'Martin Luther King Jr.'],
  ['In the end, we will remember not the words of our enemies, but the silence of our friends.', 'Martin Luther King Jr.'],
  ['Darkness cannot drive out darkness; only light can do that. Hate cannot drive out hate; only love can do that.', 'Martin Luther King Jr.'],
  ['The ultimate measure of a person is not where they stand in moments of comfort, but where they stand at times of challenge and controversy.', 'Martin Luther King Jr.'],
  ['Life\u2019s most persistent and urgent question is: what are you doing for others?', 'Martin Luther King Jr.'],
  ['If you want to go fast, go alone. If you want to go far, go together.', 'African Proverb'],
  ['It takes a village to raise a child.', 'African Proverb'],
  ['Smooth seas do not make skillful sailors.', 'African Proverb'],
  ['When there is no enemy within, the enemy outside can do you no harm.', 'African Proverb'],
  ['The best time to plant a tree was twenty years ago. The second best time is now.', 'Anonymous'],
  ['A smooth sea never made a skilled sailor.', 'English Proverb'],
  ['Every oak tree started out as a couple of nuts who stood their ground.', 'Anonymous'],
  ['You can never cross the ocean unless you have the courage to lose sight of the shore.', 'Christopher Columbus'],
  ['Life begins at the end of your comfort zone.', 'Neale Donald Walsch'],
  ['The only way to have a friend is to be one.', 'Ralph Waldo Emerson'],
  ['A ship in harbor is safe, but that is not what ships are built for.', 'John A. Shedd']
];

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER QUOTES — [text, author]
// ─────────────────────────────────────────────────────────────────────────────
const TEACHER_QUOTES = [
  // ── The Calling of Teaching ──
  ['Teaching is the one profession that creates all other professions.', 'Anonymous'],
  ['A teacher affects eternity; they can never tell where their influence stops.', 'Henry Adams'],
  ['The task of the modern educator is not to cut down jungles, but to irrigate deserts.', 'C.S. Lewis'],
  ['Teaching is not a lost art, but the regard for it is a lost tradition.', 'Jacques Barzun'],
  ['I touch the future. I teach.', 'Christa McAuliffe'],
  ['The mediocre teacher tells. The good teacher explains. The superior teacher demonstrates. The great teacher inspires.', 'William Arthur Ward'],
  ['Teaching is the greatest act of optimism.', 'Colleen Wilcox'],
  ['A teacher is a compass that activates the magnets of curiosity, knowledge, and wisdom in the pupils.', 'Ever Garrison'],
  ['Teachers, I believe, are the most responsible and important members of society because their professional efforts affect the fate of the earth.', 'Helen Caldicott'],
  ['Teaching is a very noble profession that shapes the character, caliber, and future of an individual.', 'A.P.J. Abdul Kalam'],
  ['What the teacher is, is more important than what he teaches.', 'Karl Menninger'],
  ['The influence of a great teacher can never be erased.', 'Anonymous'],
  ['The art of teaching is the art of assisting discovery.', 'Mark Van Doren'],
  ['Teaching is the profession that teaches all the other professions.', 'Anonymous'],
  ['To teach is to learn twice.', 'Joseph Joubert'],
  ['The true teacher defends his pupils against his own personal influence.', 'Amos Bronson Alcott'],
  ['Teachers can change lives with just the right mix of chalk and challenges.', 'Joyce Meyer'],
  ['A good teacher can inspire hope, ignite the imagination, and instill a love of learning.', 'Brad Henry'],
  ['Teaching might even be the greatest of the arts since the medium is the human mind and spirit.', 'John Steinbeck'],
  ['Education is not the filling of a pail, but the lighting of a fire.', 'William Butler Yeats'],
  ['Every child is a different kind of flower, and all together, they make this world a beautiful garden.', 'Anonymous'],
  ['In learning, you will teach; in teaching, you will learn.', 'Phil Collins'],
  ['A teacher plants the seeds of knowledge that grow forever.', 'Anonymous'],
  ['Great teachers empathize with kids, respect them, and believe that each one has something special that can be built upon.', 'Ann Lieberman'],
  ['The greatest sign of a success for a teacher is to be able to say, \u201cThe children are now working as if I did not exist.\u201d', 'Maria Montessori'],
  ['Teachers are those who use themselves as bridges over which they invite their students to cross.', 'Nikos Kazantzakis'],
  ['The teacher who is indeed wise does not bid you to enter the house of his wisdom but rather leads you to the threshold of your mind.', 'Kahlil Gibran'],
  ['Teaching creates all other professions.', 'Anonymous'],
  ['A teacher takes a hand, opens a mind, and touches a heart.', 'Anonymous'],
  ['The best teachers are those who show you where to look but do not tell you what to see.', 'Alexandra K. Trenfor'],
  ['I never teach my pupils; I only attempt to provide the conditions in which they can learn.', 'Albert Einstein'],
  ['Teachers open the door, but you must enter by yourself.', 'Chinese Proverb'],
  ['It is the supreme art of the teacher to awaken joy in creative expression and knowledge.', 'Albert Einstein'],
  ['A good teacher is like a candle \u2014 it consumes itself to light the way for others.', 'Mustafa Kemal Atat\u00fcrk'],
  ['The dream begins, most of the time, with a teacher who believes in you.', 'Dan Rather'],
  ['Great teachers are ordinary people doing extraordinary things.', 'Anonymous'],
  ['Teaching is the art of assisting discovery.', 'Mark Van Doren'],
  ['I cannot teach anybody anything, I can only make them think.', 'Socrates'],
  ['The object of education is to prepare the young to educate themselves throughout their lives.', 'Robert M. Hutchins'],
  ['The whole art of teaching is only the art of awakening the natural curiosity of young minds.', 'Anatole France'],
  ['To teach is to touch a life forever.', 'Anonymous'],

  // ── Impact & Legacy ──
  ['The best teachers teach from the heart, not from the book.', 'Anonymous'],
  ['A teacher\u2019s influence never truly ends. It lives on in the lives of every student they have taught.', 'Anonymous'],
  ['What we want is to see the child in pursuit of knowledge, and not knowledge in pursuit of the child.', 'George Bernard Shaw'],
  ['The greatest use of a life is to spend it for something that will outlast it.', 'William James'],
  ['Teaching children to count is fine, but teaching them what counts is best.', 'Bob Talbert'],
  ['One book, one pen, one child, and one teacher can change the world.', 'Malala Yousafzai'],
  ['A teacher is a person who never says anything new, but somehow always says it in a way that makes it new.', 'Anonymous'],
  ['The best teachers are those who teach you not just what to think, but how to think.', 'Anonymous'],
  ['You cannot teach a person anything; you can only help them find it within themselves.', 'Galileo Galilei'],
  ['The secret in education lies in respecting the student.', 'Ralph Waldo Emerson'],
  ['Good teaching is more a giving of right questions than a giving of right answers.', 'Josef Albers'],
  ['Children are not things to be molded, but are people to be unfolded.', 'Jess Lair'],
  ['Children must be taught how to think, not what to think.', 'Margaret Mead'],
  ['Teach the children so it will not be necessary to teach the adults.', 'Abraham Lincoln'],
  ['Education is the key to unlock the golden door of freedom.', 'George Washington Carver'],
  ['I never came upon any of my discoveries through the process of rational thinking.', 'Albert Einstein'],
  ['The future of the world is in my classroom today.', 'Ivan Welton Fitzwater'],
  ['Teaching is the profession that makes all other professions possible.', 'Anonymous'],
  ['What sculpture is to a block of marble, education is to the human soul.', 'Joseph Addison'],
  ['The goal of education is the advancement of knowledge and the dissemination of truth.', 'John F. Kennedy'],
  ['Children are the world\u2019s most valuable resource and its best hope for the future.', 'John F. Kennedy'],
  ['A teacher\u2019s job is to plant the seed, but the seed will grow in its own time.', 'Anonymous'],
  ['Education is the most powerful weapon you can use to change the world.', 'Nelson Mandela'],
  ['Learning is a treasure that will follow its owner everywhere.', 'Chinese Proverb'],
  ['Everyone who remembers his own education remembers teachers, not methods and techniques. The teacher is the heart of the educational system.', 'Sidney Hook'],
  ['One child, one teacher, one book, one pen can change the world.', 'Malala Yousafzai'],
  ['A teacher is one who makes himself progressively unnecessary.', 'Thomas Carruthers'],
  ['In a completely rational society, the best of us would be teachers and the rest of us would have to settle for something else.', 'Lee Iacocca'],
  ['The role of the teacher is to create the conditions for invention rather than provide ready-made knowledge.', 'Seymour Papert'],
  ['A good education can change anyone. A good teacher can change everything.', 'Anonymous'],
  ['The best teachers are those whose students leave class feeling they matter.', 'Anonymous'],
  ['The world is a book, and those who do not travel read only a page.', 'Augustine of Hippo (attributed)'],
  ['The teacher\u2019s task is not to predict the future but to enable it.', 'Anonymous'],
  ['Education is not the filling of a pail, but the lighting of a fire.', 'William Butler Yeats'],
  ['We cannot always build the future for our youth, but we can build our youth for the future.', 'Franklin D. Roosevelt'],
  ['No one has yet fully realized the wealth of sympathy, kindness, and generosity hidden in the soul of a child.', 'Emma Goldman'],
  ['The child is both a hope and a promise for mankind.', 'Maria Montessori'],
  ['Every student can learn, just not on the same day or in the same way.', 'George Evans'],
  ['To teach is to learn twice.', 'Joseph Joubert'],

  // ── Patience, Understanding & Kindness ──
  ['Patience is a virtue, and teaching is the perfect place to practice it daily.', 'Anonymous'],
  ['The best teachers are patient, understanding, and never give up on a student.', 'Anonymous'],
  ['A teacher\u2019s patience is the bridge between a student\u2019s frustration and their breakthrough.', 'Anonymous'],
  ['Kind words can be short and easy to speak, but their echoes are truly endless.', 'Mother Teresa'],
  ['I have found that children have a better idea of what is going on than most adults.', 'Jane Goodall'],
  ['Understanding a child is the first step in teaching a child.', 'Anonymous'],
  ['Children do not care how much you know until they know how much you care.', 'Anonymous'],
  ['Teaching a child is like planting a seed: it takes time, patience, and love to see it grow.', 'Anonymous'],
  ['To be a teacher is to be a learner of patience.', 'Anonymous'],
  ['Every student is a treasure waiting to be discovered.', 'Anonymous'],
  ['No significant learning occurs without a significant relationship.', 'James Comer'],
  ['It is easier to build strong children than to repair broken men.', 'Frederick Douglass'],
  ['A child misbehaving is a child needing help.', 'Anonymous'],
  ['The best teachers see the potential in every child even when they cannot see it in themselves.', 'Anonymous'],
  ['A teacher\u2019s understanding can heal more wounds than a doctor\u2019s prescriptions.', 'Anonymous'],
  ['Where there is no struggle, there is no strength.', 'Oprah Winfrey'],
  ['The struggle is a part of the story. It is not the whole story.', 'Anonymous'],
  ['When you learn, teach. When you get, give.', 'Maya Angelou'],
  ['Be a student as long as you have something to learn, and a teacher as long as you have something to share.', 'Anonymous'],
  ['One child at a time, one day at a time, one lesson at a time.', 'Anonymous'],
  ['Every student has a story. Take time to listen.', 'Anonymous'],
  ['The best classroom management plan is a caring relationship.', 'Anonymous'],
  ['Treat people as if they were what they ought to be, and you help them to become what they are capable of being.', 'Johann Wolfgang von Goethe'],
  ['The heart of teaching is a deep respect for the learner.', 'Anonymous'],
  ['You cannot pour from an empty cup. Take care of yourself first.', 'Anonymous'],
  ['The most valuable gift we can give a child is time and attention.', 'Anonymous'],
  ['Every behavior is a form of communication.', 'Anonymous'],
  ['The teachers who make the biggest difference are the ones who notice small things.', 'Anonymous'],
  ['Connection is the energy that exists between people when they feel seen and valued.', 'Bren\u00e9 Brown'],
  ['What greater grief than the loss of one\u2019s native land? \u2014 no, what greater gift than to help a child find theirs.', 'Anonymous'],
  ['Every child is gifted. They just unwrap their packages at different times.', 'Anonymous'],
  ['When children feel safe, they take risks. When they take risks, they learn.', 'Anonymous'],
  ['Good teaching cannot be reduced to technique; good teaching comes from the identity and integrity of the teacher.', 'Parker Palmer'],
  ['The classroom is a place where a child\u2019s heart can be broken or made whole.', 'Anonymous'],
  ['A child\u2019s emotional health matters more than their grades.', 'Anonymous'],
  ['Listen to the students; they will tell you how to teach them.', 'Anonymous'],
  ['Every child deserves a champion \u2014 an adult who will never give up on them.', 'Rita Pierson'],
  ['Students do not learn from people they do not like.', 'Rita Pierson'],
  ['The strongest students are those who have been encouraged, not those who have been praised.', 'Anonymous'],

  // ── The Craft of Teaching ──
  ['Tell me and I forget. Teach me and I remember. Involve me and I learn.', 'Benjamin Franklin (attributed)'],
  ['The art of teaching is the art of assisting discovery.', 'Mark Van Doren'],
  ['A teacher\u2019s greatest asset is the ability to make learning an adventure.', 'Anonymous'],
  ['The best teachers are those who show you where to look but do not tell you what to see.', 'Alexandra K. Trenfor'],
  ['Good teaching is one-fourth preparation and three-fourths theatre.', 'Gail Godwin'],
  ['In teaching you cannot see the fruit of a day\u2019s work. It is invisible and remains so, maybe for twenty years.', 'Jacques Barzun'],
  ['To teach a subject you must first love it, and then know it well enough to teach it in ways that create lovers of it.', 'Anonymous'],
  ['A great teacher makes hard things look easy, and makes easy things look interesting.', 'Anonymous'],
  ['The true art of teaching is to bore less and inspire more.', 'Anonymous'],
  ['The role of the teacher is not to answer all the questions, but to open new ones.', 'Anonymous'],
  ['A great teacher does not stand at the front of the room; they move around it, constantly.', 'Anonymous'],
  ['Questioning is to teaching what sails are to a ship.', 'Anonymous'],
  ['Education is not the filling of a pail, but the lighting of a fire.', 'William Butler Yeats'],
  ['The teachers we remember are not those who gave us answers, but those who made us question.', 'Anonymous'],
  ['A good lesson plan is a map, not a script.', 'Anonymous'],
  ['Assessment should be feedback for learning, not judgment of learning.', 'Anonymous'],
  ['The best classrooms are those where the teacher learns as much as the students.', 'Anonymous'],
  ['When students see you struggling, they learn that struggle is part of learning.', 'Anonymous'],
  ['The best moments in teaching are the ones you never planned.', 'Anonymous'],
  ['A teacher who reads is a teacher whose students will read.', 'Anonymous'],
  ['Every subject is interesting to someone \u2014 your job is to make sure that someone is every student.', 'Anonymous'],
  ['Show me, do not tell me; inspire me, do not force me.', 'Anonymous'],
  ['The art of questioning is the essence of the art of teaching.', 'Anonymous'],
  ['Learning is a result of listening, which in turn leads to even better listening and attentiveness to the other person.', 'Alice Miller'],
  ['A teacher should have maximal authority and minimal power.', 'Thomas Szasz'],
  ['Good teaching is a craft that can be learned and refined.', 'Anonymous'],
  ['The best classrooms celebrate curiosity, not compliance.', 'Anonymous'],
  ['The curriculum should serve the student, not the student the curriculum.', 'Anonymous'],
  ['A teacher\u2019s greatest teaching tool is their own example.', 'Anonymous'],
  ['A lesson that connects to a child\u2019s life will never be forgotten.', 'Anonymous'],
  ['The teachers who make the deepest impact teach more by what they do than by what they say.', 'Anonymous'],
  ['The most important lesson a teacher can teach is that learning is lifelong.', 'Anonymous'],
  ['A classroom that sparks curiosity will grow a generation of learners.', 'Anonymous'],
  ['Teaching is the highest form of understanding.', 'Aristotle'],
  ['Every teacher is a student in disguise.', 'Anonymous'],
  ['Nothing in education is so astonishing as the amount of ignorance it accumulates in the form of inert facts.', 'Henry Adams'],
  ['Education is learning what you did not even know you did not know.', 'Daniel J. Boorstin'],
  ['The great difficulty in education is to get experience out of ideas.', 'George Santayana'],
  ['The teacher is the one who gets the most out of the lessons, and the true value of education is not the knowledge, but the lifelong learning.', 'Anonymous'],

  // ── Every Child Matters ──
  ['Every student can learn, just not on the same day or in the same way.', 'George Evans'],
  ['Fair does not mean treating everyone the same; it means giving every child what they need.', 'Anonymous'],
  ['A child\u2019s future should never be determined by their past.', 'Anonymous'],
  ['There is no such thing as a bad student, only a student who has not been reached.', 'Anonymous'],
  ['All children are gifted; some just open their packages later.', 'Anonymous'],
  ['We cannot always build the future for our youth, but we can build our youth for the future.', 'Franklin D. Roosevelt'],
  ['Every child has a different learning style and pace. Each child is unique, not only capable of learning but also capable of succeeding.', 'Robert John Meehan'],
  ['You cannot teach a child you do not believe in.', 'Anonymous'],
  ['The beauty of teaching is that you never know which student you might reach. Every single one matters.', 'Anonymous'],
  ['Every student is a story waiting to be written; a teacher is only a guide.', 'Anonymous'],
  ['The best teachers are those who see the potential in every child.', 'Anonymous'],
  ['Every child is worth the effort.', 'Anonymous'],
  ['A struggling student is not a failing student. They are a student who needs a different way in.', 'Anonymous'],
  ['The student who is hardest to love is often the one who needs it most.', 'Anonymous'],
  ['If a child cannot learn the way we teach, we should teach the way they learn.', 'Ignacio Estrada'],
  ['Students do not fit into boxes. Do not try to make them.', 'Anonymous'],
  ['The best classrooms make every student feel seen.', 'Anonymous'],
  ['Every child has a genius inside them waiting to be discovered.', 'Anonymous'],
  ['The measure of a teacher is not what they teach, but what their students become.', 'Anonymous'],
  ['All students deserve to feel that they matter.', 'Anonymous'],
  ['One child, one teacher, one book, one pen can change the world.', 'Malala Yousafzai'],
  ['Every student is capable of more than they know. Our job is to help them discover it.', 'Anonymous'],
  ['The best teachers are the ones who never give up on a student.', 'Anonymous'],
  ['A child\u2019s potential is limitless when an adult believes in them.', 'Anonymous'],
  ['Every student deserves to be believed in.', 'Anonymous'],
  ['It is not enough to teach a student their strengths; teach them their possibilities.', 'Anonymous'],
  ['A student\u2019s silence is not consent. It is often a cry for help.', 'Anonymous'],
  ['Every child is intelligent in their own way.', 'Anonymous'],
  ['No child is beyond hope. No student is beyond reach.', 'Anonymous'],
  ['Every child is a seed, not a vessel.', 'Anonymous'],
  ['The greatest gift we can give a student is our belief in their future.', 'Anonymous'],
  ['We underestimate the potential of children more than we overestimate it.', 'Anonymous'],
  ['No one has yet realized the wealth of sympathy, kindness, and generosity hidden in the soul of a child.', 'Emma Goldman'],
  ['A teacher\u2019s smile can change a child\u2019s whole day.', 'Anonymous'],
  ['Not all students will remember what you taught, but they will remember how you made them feel.', 'Maya Angelou (adapted)'],
  ['The students we teach today will build the world we live in tomorrow.', 'Anonymous'],
  ['Every child is worth the investment of a lifetime.', 'Anonymous'],
  ['A teacher\u2019s belief in a student can move mountains.', 'Anonymous'],
  ['Every student is a possibility.', 'Anonymous'],

  // ── Inspiration & Encouragement ──
  ['A teacher\u2019s encouragement can change a student\u2019s life trajectory.', 'Anonymous'],
  ['It is the supreme art of the teacher to awaken joy in creative expression and knowledge.', 'Albert Einstein'],
  ['Encouragement is the spark that ignites the fire of learning.', 'Anonymous'],
  ['A kind word, a warm smile, a listening ear: these are the tools of a great teacher.', 'Anonymous'],
  ['A teacher inspires, not by force, but by example.', 'Anonymous'],
  ['A teacher who believes in you is worth more than a thousand who do not.', 'Anonymous'],
  ['Every child needs at least one adult who is irrationally crazy about them.', 'Urie Bronfenbrenner'],
  ['Teaching is a gift, and the gift is returned every time a student succeeds.', 'Anonymous'],
  ['A teacher\u2019s words echo in the mind long after the classroom is forgotten.', 'Anonymous'],
  ['It takes a big heart to shape little minds.', 'Anonymous'],
  ['Good teaching is good storytelling.', 'Anonymous'],
  ['Our job is not to prepare students for something; our job is to help students prepare themselves for anything.', 'A.J. Juliani'],
  ['A teacher who makes a child feel seen and heard is doing something truly magical.', 'Anonymous'],
  ['The best gift a teacher can give a student is hope.', 'Anonymous'],
  ['You can learn something from every student.', 'Anonymous'],
  ['If you have hope for a student, they may have hope for themselves.', 'Anonymous'],
  ['A great teacher shows you where to look but not what to see.', 'Alexandra K. Trenfor'],
  ['The greatest gift a teacher can give a student is not knowledge, but the confidence to use it.', 'Anonymous'],
  ['To inspire is not to push; it is to light the flame.', 'Anonymous'],
  ['A teacher\u2019s voice can be the voice in a student\u2019s head that says, \u201cYou can do this.\u201d', 'Anonymous'],
  ['Success in the classroom comes not from genius, but from consistency, care, and craft.', 'Anonymous'],
  ['Teach with your heart, not just your head.', 'Anonymous'],
  ['A great teacher makes every student feel like their favorite.', 'Anonymous'],
  ['Every child is a different kind of flower, and all together they make this world a beautiful garden.', 'Anonymous'],
  ['You were not teaching a subject; you were teaching a person.', 'Anonymous'],
  ['A teacher who speaks life into a student changes that student forever.', 'Anonymous'],
  ['The words a teacher uses become the words a student believes about themselves.', 'Anonymous'],
  ['Every student walks into class carrying something invisible. Be kind.', 'Anonymous'],
  ['Children learn more from what you are than from what you teach.', 'Anonymous'],
  ['Great teaching is 20 percent what you know and 80 percent who you are.', 'Anonymous'],
  ['The most important quality of a teacher is the ability to see the best in each student.', 'Anonymous'],
  ['A teacher\u2019s job is not to make students learn but to make learning irresistible.', 'Anonymous'],
  ['A teacher\u2019s love of learning is contagious.', 'Anonymous'],
  ['To inspire, a teacher must first be inspired.', 'Anonymous'],
  ['The best way to encourage a student is to listen to them.', 'Anonymous'],
  ['A single act of kindness can change a life forever.', 'Anonymous'],
  ['A teacher who smiles often teaches more effectively.', 'Anonymous'],
  ['When a student is inspired, the whole classroom feels it.', 'Anonymous'],
  ['A teacher\u2019s legacy is not measured by test scores but by the lives they shape.', 'Anonymous'],

  // ── Renewal, Passion & Joy ──
  ['Find joy in teaching, and you will find joy in every day.', 'Anonymous'],
  ['The best teachers are those who love what they do.', 'Anonymous'],
  ['A teacher\u2019s enthusiasm is contagious \u2014 spread it generously.', 'Anonymous'],
  ['Great teachers laugh often, and their students laugh with them.', 'Anonymous'],
  ['Teaching is hard work, but it is the most rewarding work there is.', 'Anonymous'],
  ['Teaching is not a job; it is a way of life.', 'Anonymous'],
  ['Teaching is not just what we do; it is part of who we are.', 'Anonymous'],
  ['The joy of teaching is the joy of watching students grow.', 'Anonymous'],
  ['The best teachers do not just teach; they inspire a love of life.', 'Anonymous'],
  ['A teacher who loves their job never really works a day in their life.', 'Anonymous'],
  ['Every day in a classroom is a chance to make a difference.', 'Anonymous'],
  ['Even the smallest act of teaching can change a life forever.', 'Anonymous'],
  ['Never forget why you became a teacher.', 'Anonymous'],
  ['A teacher who is burning out needs to remember the fire that started them.', 'Anonymous'],
  ['Take a break. Rest. The best teachers know when to recharge.', 'Anonymous'],
  ['Teaching is the profession that feels like a calling.', 'Anonymous'],
  ['A teacher\u2019s work is never done, but it is never wasted.', 'Anonymous'],
  ['Behind every successful person is a teacher who cared.', 'Anonymous'],
  ['Teaching is the quiet heroism of our time.', 'Anonymous'],
  ['Every day you are teaching a lesson far bigger than any subject.', 'Anonymous'],
  ['A great teacher does not just deliver lessons; they deliver hope.', 'Anonymous'],
  ['A teacher who has found their purpose never loses their passion.', 'Anonymous'],
  ['Take time to celebrate the small wins in your classroom.', 'Anonymous'],
  ['The best teachers are those who are still learning themselves.', 'Anonymous'],
  ['The joy of teaching is watching a student discover their own potential.', 'Anonymous'],
  ['You are not just teaching a class; you are teaching a generation.', 'Anonymous'],
  ['Even the longest, hardest day ends, and tomorrow is a fresh start.', 'Anonymous'],
  ['A teacher who invests in their own wellbeing can invest more in their students.', 'Anonymous'],
  ['The tired teacher who shows up anyway is a hero.', 'Anonymous'],
  ['Never underestimate the impact you are having every single day.', 'Anonymous'],
  ['Choose teaching every day, and one day you will see the difference you made.', 'Anonymous'],
  ['A teacher who can laugh at themselves is a teacher students trust.', 'Anonymous'],
  ['Your students may forget your lesson, but they will never forget how you made them feel.', 'Anonymous'],
  ['The classroom is a place where memories are made and futures are shaped.', 'Anonymous'],
  ['Teaching is not just a job; it is the shaping of tomorrow.', 'Anonymous'],
  ['There is no tired like teacher-tired, but there is no joy like teacher-joy.', 'Anonymous'],
  ['The best days in teaching are the ones you did not expect.', 'Anonymous'],
  ['A teacher\u2019s reward is not in the paycheck but in the faces of their students.', 'Anonymous'],
  ['Find joy in your classroom, and you will find joy in your life.', 'Anonymous'],

  // ── Professional Growth & Reflection ──
  ['A teacher who stops learning is no longer a teacher.', 'Anonymous'],
  ['Reflective teaching is the most powerful professional development.', 'Anonymous'],
  ['The best teachers are those who never stop asking, \u201cHow can I do this better?\u201d', 'Anonymous'],
  ['Every difficult class is a lesson for the teacher too.', 'Anonymous'],
  ['A great teacher is a great learner.', 'Anonymous'],
  ['Teaching is the highest form of understanding.', 'Aristotle'],
  ['To be a teacher is to be a student forever.', 'Anonymous'],
  ['Feedback from students is a gift, not a threat.', 'Anonymous'],
  ['A teacher who asks for help is stronger than one who does not.', 'Anonymous'],
  ['Great teaching is a craft that improves with every year.', 'Anonymous'],
  ['Every teacher has a bad day. Every bad day is a lesson.', 'Anonymous'],
  ['A teacher who writes about their practice becomes a better teacher.', 'Anonymous'],
  ['Teaching is a journey, not a destination.', 'Anonymous'],
  ['The best teachers are those who keep a beginner\u2019s mind.', 'Anonymous'],
  ['A great teacher does not just teach; they continually learn.', 'Anonymous'],
  ['A teacher\u2019s professional growth is a gift to their students.', 'Anonymous'],
  ['Every teacher makes mistakes. Great teachers learn from them.', 'Anonymous'],
  ['The best classrooms are led by teachers who are still curious.', 'Anonymous'],
  ['A teacher who reads widely teaches widely.', 'Anonymous'],
  ['Innovation in teaching is a gift to every student.', 'Anonymous'],
  ['A great teacher is always refining their practice.', 'Anonymous'],
  ['Teaching requires courage: courage to fail, courage to try again, courage to grow.', 'Anonymous'],
  ['Professional development is a lifelong adventure.', 'Anonymous'],
  ['The best teachers are those who keep learning from their students.', 'Anonymous'],
  ['A teacher\u2019s growth is a student\u2019s gain.', 'Anonymous'],
  ['Teaching well requires knowing yourself well.', 'Anonymous'],
  ['Every teacher should have a mentor, and every teacher should be one.', 'Anonymous'],
  ['The more a teacher learns, the more their students learn.', 'Anonymous'],
  ['A great teacher never stops studying their craft.', 'Anonymous'],
  ['Teaching is an art that requires continual refinement.', 'Anonymous'],
  ['Every lesson is a chance to do better than the last.', 'Anonymous'],
  ['The best teachers are reflective teachers.', 'Anonymous'],
  ['A teacher who celebrates their own growth celebrates their students\u2019 too.', 'Anonymous'],
  ['No one is a perfect teacher, but everyone can be a growing teacher.', 'Anonymous'],
  ['A great teacher is always a work in progress.', 'Anonymous'],
  ['Teaching is the profession that teaches all the other professions.', 'Anonymous'],
  ['A teacher\u2019s greatest lesson is often the one they learn from a student.', 'Anonymous'],
  ['Every classroom is a laboratory for lifelong learning \u2014 for teacher and student alike.', 'Anonymous'],
  ['The best teachers are those who never stop being students.', 'Anonymous']
];

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getStore() {
  try {
    // Test localStorage availability
    const t = '__aqe_test__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch {
    try { return sessionStorage; } catch { return null; }
  }
}

function seenKeyFor(userId) {
  return `acadex_quote_seen_${userId}_${todayKey()}`;
}

function recentKeyFor(userId) {
  return `acadex_quote_recent_${userId}`;
}

function readRecentIds(store, userId) {
  try {
    const raw = store.getItem(recentKeyFor(userId));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-10) : [];
  } catch { return []; }
}

function writeRecentIds(store, userId, ids) {
  try { store.setItem(recentKeyFor(userId), JSON.stringify(ids.slice(-10))); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE PICKER — avoids recently shown quotes and the just-shown one
// ─────────────────────────────────────────────────────────────────────────────
function pickQuote(pool, role, recentIds, excludeId) {
  const poolSize = pool.length;
  const candidates = [];
  for (let i = 0; i < poolSize; i++) {
    const id = `${role === 'student' ? 's' : 't'}_${String(i + 1).padStart(3, '0')}`;
    if (id === excludeId) continue;
    if (recentIds.includes(id)) continue;
    candidates.push({ id, text: pool[i][0], author: pool[i][1] });
  }
  if (candidates.length === 0) {
    // Fallback: any quote except excludeId (pool fully "recent")
    for (let i = 0; i < poolSize; i++) {
      const id = `${role === 'student' ? 's' : 't'}_${String(i + 1).padStart(3, '0')}`;
      if (id === excludeId) continue;
      candidates.push({ id, text: pool[i][0], author: pool[i][1] });
    }
  }
  if (candidates.length === 0) {
    return { id: `${role}_0`, text: pool[0][0], author: pool[0][1] };
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS INJECTION (once)
// ─────────────────────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById('aqe-styles')) return;
  const style = document.createElement('style');
  style.id = 'aqe-styles';
  style.textContent = `
    .aqe-overlay {
      position: fixed; inset: 0;
      background: rgba(15, 23, 42, 0.55);
      -webkit-backdrop-filter: blur(6px);
      backdrop-filter: blur(6px);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      opacity: 0;
      animation: aqe-fade-in 280ms cubic-bezier(0.25, 0.1, 0.25, 1) forwards;
    }
    .aqe-overlay.aqe-closing {
      animation: aqe-fade-out 220ms cubic-bezier(0.25, 0.1, 0.25, 1) forwards;
    }
    .aqe-modal {
      position: relative;
      background: #ffffff;
      border-radius: 22px;
      padding: 3rem 2.25rem 2rem;
      max-width: 560px;
      width: 100%;
      box-shadow:
        0 30px 80px rgba(15, 23, 42, 0.30),
        0 10px 30px rgba(15, 23, 42, 0.15);
      text-align: center;
      border-top: 4px solid var(--aqe-accent, #007AFF);
      transform: translateY(24px) scale(0.94);
      animation: aqe-pop-in 420ms cubic-bezier(0.34, 1.56, 0.64, 1) 100ms forwards;
    }
    .aqe-modal[data-role="student"] { --aqe-accent: #007AFF; }
    .aqe-modal[data-role="teacher"] { --aqe-accent: #5856D6; }
    .aqe-close {
      position: absolute;
      top: 14px; right: 16px;
      width: 34px; height: 34px;
      border-radius: 50%;
      border: none;
      background: rgba(120, 120, 128, 0.12);
      color: #3C3C43;
      font-size: 1rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s ease, transform 0.1s ease;
    }
    .aqe-close:hover { background: rgba(120, 120, 128, 0.22); }
    .aqe-close:active { transform: scale(0.92); }
    .aqe-mark {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 5.5rem;
      line-height: 0.5;
      color: var(--aqe-accent, #007AFF);
      opacity: 0.22;
      margin-bottom: 0.25rem;
      font-weight: 700;
      user-select: none;
    }
    .aqe-label {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--aqe-accent, #007AFF);
      margin: 0 0 1.1rem 0;
    }
    .aqe-text {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 1.35rem;
      line-height: 1.55;
      color: #1a1a1a;
      margin: 0 0 1.1rem 0;
      font-weight: 400;
      letter-spacing: -0.005em;
      quotes: none;
      min-height: 3.5em;
    }
    .aqe-author {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      font-size: 0.92rem;
      color: #6b7280;
      font-style: italic;
      margin: 0 0 1.75rem 0;
      font-weight: 500;
    }
    .aqe-actions {
      display: flex;
      gap: 10px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .aqe-btn {
      padding: 0.7rem 1.5rem;
      border-radius: 999px;
      font-size: 0.88rem;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      cursor: pointer;
      border: none;
      transition: transform 0.12s ease, background 0.2s ease, filter 0.2s ease;
    }
    .aqe-btn:active { transform: scale(0.96); }
    .aqe-btn-shuffle {
      background: rgba(120, 120, 128, 0.10);
      color: #3C3C43;
    }
    .aqe-btn-shuffle:hover { background: rgba(120, 120, 128, 0.20); }
    .aqe-btn-primary {
      background: var(--aqe-accent, #007AFF);
      color: #ffffff;
      box-shadow: 0 6px 20px rgba(0, 122, 255, 0.30);
    }
    .aqe-btn-primary:hover { filter: brightness(1.08); }
    @keyframes aqe-fade-in {
      from { opacity: 0; } to { opacity: 1; }
    }
    @keyframes aqe-fade-out {
      from { opacity: 1; } to { opacity: 0; }
    }
    @keyframes aqe-pop-in {
      to { transform: translateY(0) scale(1); }
    }
    @media (max-width: 480px) {
      .aqe-modal { padding: 2.25rem 1.5rem 1.5rem; border-radius: 20px; }
      .aqe-text { font-size: 1.15rem; }
      .aqe-mark { font-size: 4.5rem; }
      .aqe-actions { flex-direction: column-reverse; }
      .aqe-btn { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .aqe-overlay, .aqe-modal { animation-duration: 0.01ms !important; }
    }
  `;
  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL RENDERER
// ─────────────────────────────────────────────────────────────────────────────
function showQuoteModal({ role, quote, store, userId, recentIds }) {
  ensureStyles();

  const overlay = document.createElement('div');
  overlay.className = 'aqe-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'aqe-label');
  overlay.innerHTML = `
    <div class="aqe-modal" data-role="${role}">
      <button class="aqe-close" type="button" aria-label="Close">&#10005;</button>
      <div class="aqe-mark" aria-hidden="true">&ldquo;</div>
      <p class="aqe-label" id="aqe-label">A Word for Today</p>
      <blockquote class="aqe-text">${escapeHtml(quote.text)}</blockquote>
      <p class="aqe-author">\u2014 ${escapeHtml(quote.author)}</p>
      <div class="aqe-actions">
        <button class="aqe-btn aqe-btn-shuffle" type="button">&#128260; Another</button>
        <button class="aqe-btn aqe-btn-primary" type="button">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Track current quote locally so the shuffle handler can exclude it.
  let currentId = quote.id;
  let currentRecent = [...recentIds];

  const close = () => {
    overlay.classList.add('aqe-closing');
    setTimeout(() => overlay.remove(), 220);
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.aqe-close').addEventListener('click', close);
  overlay.querySelector('.aqe-btn-primary').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('.aqe-btn-shuffle').addEventListener('click', () => {
    const pool = role === 'student' ? STUDENT_QUOTES : TEACHER_QUOTES;
    const next = pickQuote(pool, role, currentRecent, currentId);
    currentId = next.id;

    // Update DOM
    const modal = overlay.querySelector('.aqe-modal');
    const textEl = modal.querySelector('.aqe-text');
    const authorEl = modal.querySelector('.aqe-author');
    textEl.textContent = next.text;
    authorEl.textContent = '\u2014 ' + next.author;

    // Small pulse animation
    modal.style.transform = 'translateY(0) scale(0.99)';
    requestAnimationFrame(() => {
      modal.style.transform = '';
    });

    // Track in recent list
    currentRecent = [...currentRecent, next.id].slice(-10);
    writeRecentIds(store, userId, currentRecent);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * initEducationalQuote
 * Shows the daily educational quote for the given role, once per calendar
 * day per (user, device). No-op if already shown today, or if arguments are
 * invalid, or if storage is unavailable.
 *
 * @param {Object} opts
 * @param {'student'|'teacher'} opts.role   Role whose quote pool to use.
 * @param {string}              opts.userId Current user's uid.
 * @param {number}             [opts.delayMs=1500]  Delay before showing.
 */
export function initEducationalQuote({ role, userId, delayMs = 1500 } = {}) {
  try {
    if (!role || (role !== 'student' && role !== 'teacher')) {
      console.warn('[EducationalQuote] Invalid role. Expected "student" or "teacher".');
      return;
    }
    if (!userId || typeof userId !== 'string') {
      console.warn('[EducationalQuote] Invalid userId.');
      return;
    }

    const store = getStore();
    if (!store) return; // No storage available → silently skip

    const key = seenKeyFor(userId);
    if (store.getItem(key) === '1') return; // Already shown today

    const pool = role === 'student' ? STUDENT_QUOTES : TEACHER_QUOTES;
    if (!pool || pool.length === 0) return;

    const recentIds = readRecentIds(store, userId);
    const quote = pickQuote(pool, role, recentIds);

    // Mark seen immediately so a fast second tab cannot also show it.
    store.setItem(key, '1');
    writeRecentIds(store, userId, [...recentIds, quote.id].slice(-10));

    // Prune keys from previous days for this user (best-effort, bounded).
    try {
      const prefix = `acadex_quote_seen_${userId}_`;
      const today = todayKey();
      for (let i = store.length - 1; i >= 0; i--) {
        const k = store.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        if (k === prefix + today) continue;
        const datePart = k.slice(prefix.length);
        // Keep only today; delete anything older.
        if (/^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart < today) {
          store.removeItem(k);
        }
      }
    } catch { /* pruning is best-effort */ }

    const show = () => {
      try {
        showQuoteModal({ role, quote, store, userId, recentIds });
      } catch (err) {
        console.warn('[EducationalQuote] Failed to render modal:', err);
      }
    };

    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', () => setTimeout(show, delayMs), { once: true });
    } else {
      setTimeout(show, delayMs);
    }
  } catch (err) {
    // Absolutely never break the dashboard.
    console.warn('[EducationalQuote] Non-fatal init error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL HELPER
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}