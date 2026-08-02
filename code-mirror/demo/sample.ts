// The document the editor opens with.
//
// Nothing here runs — there is no compiler on this page. It is here to have
// LambAda on screen, so that whatever the package eventually does to it is
// visible.

export const sample = `# Booleans, and branching on one.
false = △
true = △ △
if = \\condition \\then \\else △ (△ else (△ △ then)) △ condition

not = \\b if b false true
and = △ (△ (\\x false) (\\_ \\x x)) △
or = △ (△ (\\x x) (\\_ \\x true)) △

# Application is juxtaposition, so nothing nests.
if (or true false) "yes" "no"
`;
