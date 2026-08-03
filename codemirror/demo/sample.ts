// The document the editor opens with.
//
// Nothing here runs — there is no compiler on this page. It is here to have
// LambAda on screen, so that whatever the package eventually does to it is
// visible. It uses each of the token kinds the grammar distinguishes.

export const sample = `# Booleans, and branching on one.
false = △
true = △ △
if = \\condition \\then \\else △ (△ else (△ △ then)) △ condition

not = \\b if b false true
and = △ (△ (\\x false) (\\_ \\x x)) △
or = △ (△ (\\x x) (\\_ \\x true)) △

# Application is juxtaposition, so nothing nests.
if (or true false) "yes" "no"

# Names starting uppercase are reserved for algebraic data types.
Shape = Circle radius | Rect width height

area = \\shape shape (\\r 3 r r) (\\w \\h w h)
area $ Rect 4 7

# Lists, records, and a character constant.
[ area (Circle 1), 0, 'x' ]
{ "kind": Circle, "arity": 1 }

# Error handling
line with unresolved symbols
line with invalid syntax :(
`;
